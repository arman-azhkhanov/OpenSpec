import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Validator, resolveSpecArtifactFormat } from '../../src/core/validation/validator.js';
import { SpecCommand, registerSpecCommand } from '../../src/commands/spec.js';
import { generateApplyInstructions } from '../../src/commands/workflow/instructions.js';
import { resolveFormat } from '../../src/core/parsers/grammar.js';
import { findMainSpecStructureIssues } from '../../src/core/parsers/spec-structure.js';

const ORG = resolveFormat({ format: { markup: 'org' } });

/**
 * The main spec archive would have written: org headers, and an `:ID:` in a
 * property drawer under every requirement.
 */
const MAIN_SPEC_ORG = [
  '#+TITLE: data-export Specification',
  '',
  '* Purpose',
  '',
  'Lets users take their data out of the product in a portable, documented format.',
  '',
  '* Requirements',
  '',
  '** Requirement: User can export data',
  ':PROPERTIES:',
  ':ID: req-data-export-user-can-export-data',
  ':END:',
  'The system SHALL allow users to export their data in CSV format.',
  '',
  '*** Scenario: Successful export',
  '- *WHEN* the user asks for an export',
  '- *THEN* the system writes a CSV file',
  '',
].join('\n');

/** The same spec in Markdown, so every org assertion has a control. */
const MAIN_SPEC_MD = [
  '# data-export Specification',
  '',
  '## Purpose',
  '',
  'Lets users take their data out of the product in a portable, documented format.',
  '',
  '## Requirements',
  '',
  '### Requirement: User can export data',
  'The system SHALL allow users to export their data in CSV format.',
  '',
  '#### Scenario: Successful export',
  '- **WHEN** the user asks for an export',
  '- **THEN** the system writes a CSV file',
  '',
].join('\n');

const DELTA_SPEC_ORG = [
  '* ADDED Requirements',
  '',
  '** Requirement: User can export data',
  'The system SHALL allow users to export their data in CSV format.',
  '',
  '*** Scenario: Successful export',
  '- *WHEN* the user asks for an export',
  '- *THEN* the system writes a CSV file',
  '',
].join('\n');

const TASKS_ORG = [
  '* 1. Work',
  '',
  '- [X] 1.1 done',
  '- [-] 1.2 started',
  '- [ ] 1.3 open',
  '',
].join('\n');

function messagesOf(report: { issues: Array<{ message: string }> }): string {
  return report.issues.map(issue => issue.message).join('\n');
}

async function validateOrgSpec(content: string, strict = false) {
  return new Validator(strict).validateSpecContent('data-export', content, ORG);
}

// -----------------------------------------------------------------------------
// B-1: the main spec's structural checks reach org
// -----------------------------------------------------------------------------

describe('validator: main spec structure is read in the resolved format (B-1)', () => {
  const withDuplicate = MAIN_SPEC_ORG.replace(
    '** Requirement: User can export data\n:PROPERTIES:',
    [
      '** Requirement: User can export data',
      ':PROPERTIES:',
      ':ID: req-data-export-second',
      ':END:',
      'The system SHALL also do it twice.',
      '',
      '*** Scenario: Twice',
      '- *WHEN* asked twice',
      '- *THEN* done twice',
      '',
      '** Requirement: User can export data',
      ':PROPERTIES:',
    ].join('\n')
  );

  it('plants a real duplicate (control on the fixture itself)', () => {
    expect(withDuplicate).not.toBe(MAIN_SPEC_ORG);
    expect(withDuplicate.match(/^\*\* Requirement: User can export data$/gmu)).toHaveLength(2);
  });

  it('reports the duplicate requirement header through the validator', async () => {
    // The whole of B-1: `applySpecRules` used to call the structure reader
    // without a format, so all three of its checks returned nothing for any
    // non-markdown spec and the file validated clean.
    const report = await validateOrgSpec(withDuplicate);

    expect(messagesOf(report)).toContain('duplicates the requirement declared on line');
    expect(report.valid).toBe(false);
  });

  it('is the format that makes the difference, not the content (both signs)', () => {
    // Same text, same function: with the org format the duplicate is seen, with
    // the markdown default nothing is. This pair is what would redden if the
    // argument were dropped again.
    expect(findMainSpecStructureIssues(withDuplicate, ORG).map(i => i.kind)).toContain(
      'duplicate-requirement'
    );
    expect(findMainSpecStructureIssues(withDuplicate)).toEqual([]);
  });

  it('leaves the markdown path exactly as it was (must-stay-green)', async () => {
    const mdDuplicate = MAIN_SPEC_MD.replace(
      '### Requirement: User can export data',
      '### Requirement: User can export data\nThe system SHALL do it.\n\n#### Scenario: One\n- **WHEN** a\n- **THEN** b\n\n### Requirement: User can export data'
    );

    const clean = await new Validator().validateSpecContent('data-export', MAIN_SPEC_MD);
    const duplicated = await new Validator().validateSpecContent('data-export', mdDuplicate);

    expect(clean.valid).toBe(true);
    expect(messagesOf(duplicated)).toContain('duplicates the requirement declared on line');
  });
});

// -----------------------------------------------------------------------------
// B-2: delta discovery inside validateChangeDeltaSpecs is format-aware
// -----------------------------------------------------------------------------

describe('validator: change delta discovery uses the resolved spec file name (B-2)', () => {
  let root: string;
  let changeDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-deltas-'));
    changeDir = path.join(root, 'openspec', 'changes', 'add-export');
    await fs.mkdir(path.join(changeDir, 'specs', 'data-export'), { recursive: true });
    await fs.writeFile(
      path.join(changeDir, 'specs', 'data-export', 'spec.org'),
      DELTA_SPEC_ORG
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds the org delta and validates it', async () => {
    const report = await new Validator().validateChangeDeltaSpecs(changeDir, { format: ORG });

    expect(messagesOf(report)).not.toContain('No deltas found');
    expect(report.valid).toBe(true);
  });

  it('finds nothing when the format is not passed (the other sign)', async () => {
    // The exact defect: discovery looked for `spec.md`, so a change whose
    // deltas are all `.org` reported "no deltas" and archive refused it.
    const report = await new Validator().validateChangeDeltaSpecs(changeDir);

    expect(report.valid).toBe(false);
    expect(messagesOf(report)).toContain('delta');
  });
});

// -----------------------------------------------------------------------------
// M-3: org identity (plan §3(г)/(д))
// -----------------------------------------------------------------------------

describe('validator: org requirement identity (plan §3(г)/(д))', () => {
  it('accepts the minted shape, strict and non-strict (control)', async () => {
    expect((await validateOrgSpec(MAIN_SPEC_ORG)).valid).toBe(true);
    expect((await validateOrgSpec(MAIN_SPEC_ORG, true)).valid).toBe(true);
  });

  it('rejects a drawer that is never terminated (§3(г))', async () => {
    const planted = MAIN_SPEC_ORG.replace(':END:\n', '');

    expect(planted).not.toBe(MAIN_SPEC_ORG);
    const report = await validateOrgSpec(planted);
    expect(messagesOf(report)).toContain('is never closed');
    expect(report.valid).toBe(false);
  });

  it('rejects two requirements sharing one id (§3(д))', async () => {
    const planted = MAIN_SPEC_ORG.replace(
      '\n*** Scenario: Successful export',
      [
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes a CSV file',
        '',
        '** Requirement: User can import data',
        ':PROPERTIES:',
        ':ID: req-data-export-user-can-export-data',
        ':END:',
        'The system SHALL allow users to import their data.',
        '',
        '*** Scenario: Successful import',
      ].join('\n')
    );

    expect(planted).not.toBe(MAIN_SPEC_ORG);
    const report = await validateOrgSpec(planted);
    expect(messagesOf(report)).toContain('is declared again in the drawer opened on line');
    expect(report.valid).toBe(false);
  });

  it('asks for an id in a main spec only under --strict (§3(д))', async () => {
    const planted = MAIN_SPEC_ORG.replace(
      ':PROPERTIES:\n:ID: req-data-export-user-can-export-data\n:END:\n',
      ''
    );

    expect(planted).not.toBe(MAIN_SPEC_ORG);
    // Both signs, because the plan puts this rule behind --strict and nowhere
    // else: a hand-written spec keeps validating, a strict run does not.
    expect((await validateOrgSpec(planted)).valid).toBe(true);
    const strict = await validateOrgSpec(planted, true);
    expect(messagesOf(strict)).toContain('has no id property');
    expect(strict.valid).toBe(false);
  });

  it('reproduces the verifier probe: duplicate id AND an unterminated drawer', async () => {
    const planted = MAIN_SPEC_ORG.concat(
      [
        '** Requirement: User can import data',
        ':PROPERTIES:',
        ':ID: req-data-export-user-can-export-data',
        'The system SHALL allow users to import their data.',
        '',
        '*** Scenario: Successful import',
        '- *WHEN* asked',
        '- *THEN* done',
        '',
      ].join('\n')
    );

    const report = await validateOrgSpec(planted, true);

    expect(report.valid).toBe(false);
    expect(messagesOf(report)).toContain('is never closed');
    expect(messagesOf(report)).toContain('is declared again in the drawer opened on line');
  });

  it('says nothing about drawers in markdown (must-stay-green)', async () => {
    // A markdown format has no drawer tokens at all, so the pass is skipped
    // whole. Text that would be a defect in org is ordinary prose here.
    const mdWithDrawerText = MAIN_SPEC_MD.replace(
      '### Requirement: User can export data',
      '### Requirement: User can export data\n:PROPERTIES:\n:ID: req-a\n:ID: req-a'
    );

    const report = await new Validator(true).validateSpecContent(
      'data-export',
      mdWithDrawerText
    );

    expect(messagesOf(report)).not.toContain('is never closed');
    expect(messagesOf(report)).not.toContain('has no id property');
  });

  it('does not ask a change delta for ids it has not been minted yet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-identity-'));
    try {
      const changeDir = path.join(root, 'openspec', 'changes', 'add-export');
      await fs.mkdir(path.join(changeDir, 'specs', 'data-export'), { recursive: true });
      await fs.writeFile(
        path.join(changeDir, 'specs', 'data-export', 'spec.org'),
        DELTA_SPEC_ORG
      );

      const report = await new Validator(true).validateChangeDeltaSpecs(changeDir, {
        format: ORG,
      });

      expect(messagesOf(report)).not.toContain('has no id property');
      expect(report.valid).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does report a delta whose own drawer is broken', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-identity-d-'));
    try {
      const changeDir = path.join(root, 'openspec', 'changes', 'add-export');
      await fs.mkdir(path.join(changeDir, 'specs', 'data-export'), { recursive: true });
      await fs.writeFile(
        path.join(changeDir, 'specs', 'data-export', 'spec.org'),
        DELTA_SPEC_ORG.replace(
          '** Requirement: User can export data\n',
          '** Requirement: User can export data\n:PROPERTIES:\n:ID: req-pinned\n'
        )
      );

      const report = await new Validator().validateChangeDeltaSpecs(changeDir, { format: ORG });

      expect(messagesOf(report)).toContain('is never closed');
      expect(report.valid).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// M-2 / M-6: the spec command speaks the schema's file name and format
// -----------------------------------------------------------------------------

describe('spec command: spec file name and parse format come from the schema (M-2, M-6)', () => {
  let root: string;
  let logs: string[];
  let errors: string[];
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  async function project(schema: string, specFile: string, content: string): Promise<void> {
    await fs.mkdir(path.join(root, 'openspec', 'specs', 'data-export'), { recursive: true });
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), `schema: ${schema}\n`);
    await fs.writeFile(
      path.join(root, 'openspec', 'specs', 'data-export', specFile),
      content
    );
  }

  async function runSpecSubcommand(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program);
    await program.parseAsync(args, { from: 'user' });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-speccmd-'));
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows an org spec instead of reporting it missing', async () => {
    await project('ibalta-org', 'spec.org', MAIN_SPEC_ORG);

    await new SpecCommand(root).show('data-export', { json: true });

    const output = JSON.parse(logs.join('\n'));
    expect(output.id).toBe('data-export');
    // Parsed, not merely found: a spec read with the markdown parser has no
    // requirements at all, which is the half a file-name-only fix would miss.
    expect(output.requirementCount).toBe(1);
  });

  it('still shows a markdown spec of a markdown project (must-stay-green)', async () => {
    await project('spec-driven', 'spec.md', MAIN_SPEC_MD);

    await new SpecCommand(root).show('data-export', { json: true });

    const output = JSON.parse(logs.join('\n'));
    expect(output.requirementCount).toBe(1);
  });

  it('lists and validates an org spec from the noun-form commands', async () => {
    await project('ibalta-org', 'spec.org', MAIN_SPEC_ORG);
    process.chdir(root);

    await runSpecSubcommand(['spec', 'list']);
    expect(logs.join('\n')).toContain('data-export');
    expect(logs.join('\n')).not.toContain('No items found');

    logs.length = 0;
    await runSpecSubcommand(['spec', 'validate', 'data-export', '--no-interactive']);
    expect(logs.join('\n')).toContain("Specification 'data-export' is valid");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('keeps listing a markdown project the same way (must-stay-green)', async () => {
    await project('spec-driven', 'spec.md', MAIN_SPEC_MD);
    process.chdir(root);

    await runSpecSubcommand(['spec', 'list']);

    expect(logs.join('\n')).toContain('data-export');
  });
});

// -----------------------------------------------------------------------------
// M-5: the apply checklist counts tasks with the change's own format
// -----------------------------------------------------------------------------

describe('apply instructions: the task denominator is the schema’s (M-5)', () => {
  let root: string;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-apply-'));
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
    const changeDir = path.join(root, 'openspec', 'changes', 'add-export');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: ibalta-org\n');
    await fs.writeFile(path.join(changeDir, '.openspec.yaml'), 'schema: ibalta-org\n');
    await fs.writeFile(path.join(changeDir, 'tasks.org'), TASKS_ORG);
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('counts the same three tasks `openspec list` counts', async () => {
    // The defect was a second denominator: this checklist read `tasks.org` with
    // the markdown pattern, so `[-]` and `+` bullets fell out of it while
    // `openspec list` and archive counted them. 3, not 2.
    const instructions = await generateApplyInstructions(root, 'add-export');

    expect(instructions.progress.total).toBe(3);
    expect(instructions.progress.complete).toBe(1);
  });

  it('lists the in-progress task as work an agent can pick up', async () => {
    const instructions = await generateApplyInstructions(root, 'add-export');

    expect(instructions.tasks.map(task => task.description)).toContain('1.2 started');
  });
});

// -----------------------------------------------------------------------------
// m-5: archive's proposal warnings are worded in the change's own format
// -----------------------------------------------------------------------------

describe('validator: validateChange words its remediation in the given format (m-5)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-proposal-'));
    await fs.mkdir(path.join(root, 'add-export'), { recursive: true });
    // A proposal that is missing its sections under EITHER grammar, so the
    // enriched message is the only thing that moves between the two runs.
    await fs.writeFile(path.join(root, 'add-export', 'proposal.md'), 'nothing here\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('names the org section headers when the org format is passed', async () => {
    const file = path.join(root, 'add-export', 'proposal.md');

    const asOrg = await new Validator().validateChange(file, ORG);
    const asMarkdown = await new Validator().validateChange(file);

    expect(messagesOf(asOrg)).toContain('"* Why"');
    expect(messagesOf(asOrg)).not.toContain('"## Why"');
    // The other sign: unresolved callers keep the markdown wording they had.
    expect(messagesOf(asMarkdown)).toContain('"## Why"');
  });

  it('archive passes its resolved format to that call', async () => {
    // A source lock on the argument's presence, kept because a caller can drop
    // it back to the default without any behavioural test noticing which of the
    // two callers regressed.
    //
    // ⚠ The premise this comment used to carry is DEAD and was wrong to leave
    // standing: it said archive reaches this call through a hard-coded
    // `proposal.md`, "so in an org project the call is never made and no
    // behavioural test can observe the fix". `resolveProposalPath` resolves the
    // proposal from the schema's `generates`, the call IS made on org projects
    // (archive prints `Proposal warnings in proposal.org`), and the behaviour is
    // observed in `test/org/validate.test.ts` §F-7. Measured 0820b.
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'core', 'archive.ts'),
      'utf-8'
    );

    expect(source).toContain('validator.validateChange(changeFile, format)');
    // Control that the read hit the right file and the format is in scope there.
    expect(source).toContain('const format = resolveSpecArtifactFormat(root.path, changeDir);');
  });
});

// -----------------------------------------------------------------------------
// m-4: which artifact owns the main specs
// -----------------------------------------------------------------------------

describe('validator: the spec artifact is chosen by what it generates (m-4)', () => {
  let root: string;

  async function schema(generates: string, markup?: string): Promise<void> {
    const dir = path.join(root, 'openspec', 'schemas', 'probe');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'schema.yaml'),
      [
        'name: probe',
        'version: 1',
        'artifacts:',
        '  - id: proposal',
        '    generates: proposal.md',
        '    description: p',
        '    template: proposal.md',
        '  - id: specs',
        `    generates: "${generates}"`,
        '    description: s',
        '    template: spec.md',
        ...(markup ? ['    format:', `      markup: ${markup}`] : []),
        '    requires: [proposal]',
        '',
      ].join('\n')
    );
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: probe\n');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-f1-artifact-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves an artifact whose glob is written with a leading ./', async () => {
    // `./specs/**/*.org` is a legal glob the artifact graph's own tests use, and
    // the string-prefix test this replaces did not see it: the project fell back
    // to markdown and every org file went missing.
    await schema('./specs/**/*.org', 'org');

    expect(resolveSpecArtifactFormat(root).markup).toBe('org');
    expect(resolveSpecArtifactFormat(root).SPEC_FILE).toBe('spec.org');
  });

  it('resolves the plain glob the same way (control)', async () => {
    await schema('specs/**/*.org', 'org');

    expect(resolveSpecArtifactFormat(root).markup).toBe('org');
  });

  it('keeps the shipped markdown schema on markdown (must-stay-green)', async () => {
    await schema('specs/**/*.md');

    expect(resolveSpecArtifactFormat(root).markup).toBe('markdown');
    expect(resolveSpecArtifactFormat(root).SPEC_FILE).toBe('spec.md');
  });

  it('does not pick an artifact that generates nothing under specs/', async () => {
    await schema('docs/**/*.org', 'org');

    expect(resolveSpecArtifactFormat(root).markup).toBe('markdown');
  });
});
