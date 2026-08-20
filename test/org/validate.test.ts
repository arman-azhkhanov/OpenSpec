import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { Validator } from '../../src/core/validation/validator.js';
import { ChangeCommand } from '../../src/commands/change.js';
import { MarkdownParser } from '../../src/core/parsers/markdown-parser.js';
import { findMainSpecStructureIssues } from '../../src/core/parsers/spec-structure.js';
import { resolveFormat } from '../../src/core/parsers/grammar.js';

const ORG = resolveFormat({ format: { markup: 'org' } });
const MARKDOWN = resolveFormat();

/**
 * A main spec that validates, so every plant below is a one-line mutation of it.
 *
 * The property drawer is part of being well-formed, not decoration: a merged
 * main spec is written by archive, which mints an `:ID:` for every requirement
 * it adds, and a requirement without one is flagged under `--strict` (plan
 * §3(а)/(д)). A fixture with no drawer would be a spec no emitter produces.
 */
const VALID_ORG_SPEC = [
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

/** The same spec in Markdown, so every org assertion has a must-stay-green twin. */
const VALID_MD_SPEC = [
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

async function validate(content: string, strict = false) {
  return new Validator(strict).validateSpecContent('data-export', content, ORG);
}

function messagesOf(report: { issues: Array<{ message: string }> }): string {
  return report.issues.map(issue => issue.message).join('\n');
}

describe('org: main spec validation', () => {
  it('accepts a well-formed org spec, strict and non-strict (control)', async () => {
    // The green half of every plant below. Without it, a validator that
    // rejected everything would "pass" all the red assertions.
    expect((await validate(VALID_ORG_SPEC)).valid).toBe(true);
    expect((await validate(VALID_ORG_SPEC, true)).valid).toBe(true);
  });

  it('rejects the same spec written in markdown', async () => {
    // Reddens if org recognition silently kept the markdown anchors as
    // alternatives: both grammars would then parse and nothing would discriminate.
    const report = await validate(VALID_MD_SPEC);

    expect(report.valid).toBe(false);
    expect((await new Validator().validateSpecContent('data-export', VALID_MD_SPEC)).valid).toBe(
      true
    );
  });

  it('reddens when a scenario is raised to the requirement level (plan §5 must-redden 7)', async () => {
    const planted = VALID_ORG_SPEC.replace('*** Scenario:', '** Scenario:');

    expect(planted).not.toBe(VALID_ORG_SPEC);
    expect((await validate(planted, true)).valid).toBe(false);
  });

  it('reddens when a requirement is shifted one level deeper (plan §5 must-redden 7)', async () => {
    const planted = VALID_ORG_SPEC.replace('** Requirement:', '*** Requirement:');

    expect(planted).not.toBe(VALID_ORG_SPEC);
    expect((await validate(planted, true)).valid).toBe(false);
  });

  it('accepts a scenario nested BELOW its requirement, exactly as markdown does', async () => {
    // Not a slack assertion - a calibration one. `#####` under `###` validates
    // upstream too, so "shift the scenario one level" only reddens downward.
    // Asserting it here keeps a future org criterion from being written in the
    // direction that is green in both families and therefore proves nothing.
    const deeper = VALID_ORG_SPEC.replace('*** Scenario:', '**** Scenario:');
    const mdDeeper = VALID_MD_SPEC.replace('#### Scenario:', '##### Scenario:');

    expect((await validate(deeper, true)).valid).toBe(true);
    expect(
      (await new Validator(true).validateSpecContent('data-export', mdDeeper)).valid
    ).toBe(true);
  });

  it('reddens when a scenario body is emptied (seed must-redden 4)', async () => {
    const planted = VALID_ORG_SPEC.replace(
      '- *WHEN* the user asks for an export\n- *THEN* the system writes a CSV file',
      ''
    );

    expect(planted).not.toBe(VALID_ORG_SPEC);
    const report = await validate(planted);
    expect(report.valid).toBe(false);
    expect(messagesOf(report)).toMatch(/Scenario/i);
  });

  it('reddens under --strict when no normative keyword is left', async () => {
    const planted = VALID_ORG_SPEC.replace('SHALL allow', 'lets');

    expect(planted).not.toBe(VALID_ORG_SPEC);
    // Both signs: strict is the only mode that asks for the keyword, so a
    // plant that reddened non-strict too would mean something else broke.
    expect((await validate(planted)).valid).toBe(true);
    expect((await validate(planted, true)).valid).toBe(false);
  });

  it('reddens when a requirement has no scenario at all', async () => {
    const planted = VALID_ORG_SPEC.split('*** Scenario:')[0];

    expect(planted).not.toBe(VALID_ORG_SPEC);
    expect((await validate(planted)).valid).toBe(false);
  });
});

describe('org: a fence hides nothing, a comma escapes (plan §3(в), §5 must-redden 5)', () => {
  const withEscapedExample = [
    '#+TITLE: data-export Specification',
    '',
    '* Purpose',
    '',
    'Lets users take their data out of the product in a portable, documented format.',
    '',
    '* Requirements',
    '',
    '** Requirement: User can export data',
    'The system SHALL allow users to export their data in CSV format.',
    '',
    '#+begin_example',
    ',** Requirement: Illustration only',
    '#+end_example',
    '',
    '*** Scenario: Successful export',
    '- *WHEN* the user asks for an export',
    '- *THEN* the system writes a CSV file',
    '',
  ].join('\n');

  function requirementCount(content: string): number {
    return new MarkdownParser(content, ORG).parseSpec('data-export').requirements.length;
  }

  it('does not read a comma-escaped heading inside a block as a requirement', () => {
    expect(requirementCount(withEscapedExample)).toBe(1);
  });

  it('does read the same line once the comma is removed', () => {
    // The other sign. `#+begin_example` is deliberately not a mask in Org, so
    // the comma is the ONLY thing keeping the illustration out of the spec —
    // this pair is what proves it, and it reddens the moment a fence starts
    // masking headings again.
    const unescaped = withEscapedExample.replace('\n,** Requirement:', '\n** Requirement:');

    expect(unescaped).not.toBe(withEscapedExample);
    expect(requirementCount(unescaped)).toBe(2);
  });

  it('keeps markdown fences masking, which is where they do hide structure (control)', () => {
    const md = [
      '# data-export Specification',
      '',
      '## Purpose',
      '',
      'Lets users take their data out of the product in a portable, documented format.',
      '',
      '## Requirements',
      '',
      '### Requirement: Real one',
      'The system SHALL work.',
      '',
      '```',
      '### Requirement: Illustration only',
      '```',
      '',
      '#### Scenario: Works',
      '- **WHEN** asked',
      '- **THEN** done',
      '',
    ].join('\n');

    expect(
      new MarkdownParser(md, MARKDOWN).parseSpec('data-export').requirements
    ).toHaveLength(1);
  });
});

describe('org: main spec structure issues speak org', () => {
  it('names a delta header in a main spec with the org token and file name', () => {
    const issues = findMainSpecStructureIssues(
      ['* Requirements', '', '* ADDED Requirements', ''].join('\n'),
      ORG
    );

    expect(issues.map(issue => issue.kind)).toContain('delta-header');
    // Reddens if the message is left on the markdown literals: an org author
    // would be told to look at a `spec.md` and a `## Requirements` that do not
    // exist in their project.
    expect(issues[0].message).toContain('spec.org');
    expect(issues[0].message).toContain('* Requirements');
    expect(issues[0].message).not.toContain('spec.md');
  });

  it('spots a duplicate org requirement', () => {
    const issues = findMainSpecStructureIssues(
      [
        '* Requirements',
        '',
        '** Requirement: Same name',
        'text',
        '',
        '** Requirement: Same name',
        'text',
        '',
      ].join('\n'),
      ORG
    );

    expect(issues.map(issue => issue.kind)).toContain('duplicate-requirement');
  });

  it('leaves the markdown reading of the same shapes alone (control)', () => {
    const md = ['## Requirements', '', '## ADDED Requirements', ''].join('\n');

    expect(findMainSpecStructureIssues(md).map(issue => issue.kind)).toEqual(['delta-header']);
    expect(findMainSpecStructureIssues(md)[0].message).toContain('spec.md');
    // An org document read as markdown yields nothing, which is exactly why
    // the format has to reach this function at all.
    expect(findMainSpecStructureIssues('* Requirements\n\n* ADDED Requirements\n')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Deprecated `openspec change validate` on an org project (m-B1 lock).
//
// The fix this locks is `format: changeFormat` in ChangeCommand.validate's call
// to validateChangeDeltaSpecs (change.ts). Nothing in the suite exercised the
// deprecated command on an org project (acc3 §6: `grep -rln "ChangeCommand" test/org/`
// = 0 files), so the fix rested on a hand probe. Removing that one argument turns
// the valid org change below into `Change must have at least one delta` — the
// exact m-B1 symptom — while the Markdown twin stays green, which is why both
// cells are asserted here.
// -----------------------------------------------------------------------------

describe('org: the deprecated change validate reads deltas in the project markup (m-B1)', () => {
  const ORG_PROPOSAL = [
    '#+TITLE: Add data export',
    '',
    '* Why',
    '',
    'Users cannot take their data out of the product today, and support runs exports by hand.',
    '',
    '* What Changes',
    '',
    '- Add a CSV export endpoint.',
    '',
  ].join('\n');

  const MD_PROPOSAL = [
    '# Add data export',
    '',
    '## Why',
    '',
    'Users cannot take their data out of the product today, and support runs exports by hand.',
    '',
    '## What Changes',
    '',
    '- Add a CSV export endpoint.',
    '',
  ].join('\n');

  const ORG_DELTA = [
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

  const MD_DELTA = [
    '## ADDED Requirements',
    '',
    '### Requirement: User can export data',
    'The system SHALL allow users to export their data in CSV format.',
    '',
    '#### Scenario: Successful export',
    '- **WHEN** the user asks for an export',
    '- **THEN** the system writes a CSV file',
    '',
  ].join('\n');

  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-mb1-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  /** A project whose schema is `schema`, holding one change named `probe`. */
  async function project(
    schema: string,
    proposalFile: string,
    proposal: string,
    specFile: string,
    delta: string
  ): Promise<string> {
    const dir = path.join(root, schema);
    const changeDir = path.join(dir, 'openspec', 'changes', 'probe');
    await fs.mkdir(path.join(changeDir, 'specs', 'data-export'), { recursive: true });
    await fs.mkdir(path.join(dir, 'openspec', 'specs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'openspec', 'config.yaml'), `schema: ${schema}\n`, 'utf-8');
    await fs.writeFile(path.join(changeDir, '.openspec.yaml'), `schema: ${schema}\n`, 'utf-8');
    await fs.writeFile(path.join(changeDir, proposalFile), proposal, 'utf-8');
    await fs.writeFile(path.join(changeDir, 'specs', 'data-export', specFile), delta, 'utf-8');
    return dir;
  }

  /** Runs the deprecated command in `dir` and returns the JSON report it prints. */
  async function changeValidate(dir: string): Promise<{ valid: boolean; issues: Array<{ message: string }> }> {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    process.chdir(dir);
    try {
      console.log = (msg?: any, ...args: any[]) => {
        logs.push([msg, ...args].filter(Boolean).join(' '));
      };
      console.error = () => {};
      await new ChangeCommand().validate('probe', { json: true });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    // The deprecation notice goes to stderr; stdout is the report alone.
    return JSON.parse(logs.join('\n'));
  }

  it('calls a valid org change valid', async () => {
    const dir = await project('ibalta-org', 'proposal.org', ORG_PROPOSAL, 'spec.org', ORG_DELTA);

    const report = await changeValidate(dir);

    // Reddens with `format: changeFormat` removed from the call: the org delta
    // headers become invisible and the report is
    // "Change must have at least one delta" (acc3 §3, both signs).
    expect(report.valid).toBe(true);
  });

  it('calls the Markdown twin valid (control: the plant above must not redden this one)', async () => {
    const dir = await project('spec-driven', 'proposal.md', MD_PROPOSAL, 'spec.md', MD_DELTA);

    expect((await changeValidate(dir)).valid).toBe(true);
  });

  it('still reddens on an org change whose requirement has no scenario (negative control)', async () => {
    // Without this, "valid: true" above is not evidence: a command that called
    // everything valid would satisfy it. Subtracting the single Scenario block
    // is the live redaction of readiness criterion 4 (patch plan §5).
    const noScenario = ORG_DELTA.split('*** Scenario:')[0];
    expect(noScenario).not.toBe(ORG_DELTA);
    const dir = await project('ibalta-org', 'proposal.org', ORG_PROPOSAL, 'spec.org', noScenario);

    const report = await changeValidate(dir);

    expect(report.valid).toBe(false);
    expect(messagesOf(report)).toMatch(/at least one scenario/i);
  });
});

// -----------------------------------------------------------------------------
// `Validator.validateChange` and the proposal's own markup (F-7 lock).
//
// The proposal-level pass built its ChangeParser without the format it was
// handed, so it looked for `## Why` in a document whose sections are `* Why`
// (validator.ts, recon R3 §4.1). Archive's non-blocking warning printed
// "Change must have a Why section" on every org change that has one — the
// message even quoted the org headers, because only the enrichment was
// format-aware. This locks the parse, not the wording.
// -----------------------------------------------------------------------------

describe('org: the proposal pass reads the proposal in its own markup (F-7)', () => {
  const WHY_LINE = 'Users cannot take their data out of the product today, and support runs exports by hand.';

  const ORG_PROPOSAL = ['#+TITLE: Add data export', '', '* Why', '', WHY_LINE, '', '* What Changes', '', '- Add a CSV export endpoint.', ''].join('\n');
  const ORG_PROPOSAL_NO_WHY = ['#+TITLE: Add data export', '', '* What Changes', '', '- Add a CSV export endpoint.', ''].join('\n');
  const MD_PROPOSAL = ['# Add data export', '', '## Why', '', WHY_LINE, '', '## What Changes', '', '- Add a CSV export endpoint.', ''].join('\n');
  const MD_PROPOSAL_NO_WHY = ['# Add data export', '', '## What Changes', '', '- Add a CSV export endpoint.', ''].join('\n');

  const ORG_DELTA = ['* ADDED Requirements', '', '** Requirement: User can export data', 'The system SHALL allow users to export their data in CSV format.', '', '*** Scenario: Successful export', '- *WHEN* the user asks for an export', '- *THEN* the system writes a CSV file', ''].join('\n');
  const MD_DELTA = ['## ADDED Requirements', '', '### Requirement: User can export data', 'The system SHALL allow users to export their data in CSV format.', '', '#### Scenario: Successful export', '- **WHEN** the user asks for an export', '- **THEN** the system writes a CSV file', ''].join('\n');

  const MISSING_WHY = /Change must have a Why section/;

  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-f7-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Writes a change directory and returns the path of its proposal. */
  async function change(
    name: string,
    proposalFile: string,
    proposal: string,
    specFile: string,
    delta: string
  ): Promise<string> {
    const changeDir = path.join(root, name);
    await fs.mkdir(path.join(changeDir, 'specs', 'data-export'), { recursive: true });
    await fs.writeFile(path.join(changeDir, 'specs', 'data-export', specFile), delta, 'utf-8');
    const proposalPath = path.join(changeDir, proposalFile);
    await fs.writeFile(proposalPath, proposal, 'utf-8');
    return proposalPath;
  }

  it('does not claim an org proposal is missing the Why section it has', async () => {
    const proposal = await change('probe', 'proposal.org', ORG_PROPOSAL, 'spec.org', ORG_DELTA);

    const report = await new Validator().validateChange(proposal, ORG);

    expect(messagesOf(report)).not.toMatch(MISSING_WHY);
    expect(report.valid).toBe(true);
  });

  it('still says so when the org proposal really has no Why section', async () => {
    // The other sign. Without it, passing any format that silenced the check
    // would satisfy the assertion above.
    const proposal = await change('probe', 'proposal.org', ORG_PROPOSAL_NO_WHY, 'spec.org', ORG_DELTA);

    const report = await new Validator().validateChange(proposal, ORG);

    expect(messagesOf(report)).toMatch(MISSING_WHY);
    // Named in the reader's own markup, which is what made the false positive
    // above so convincing.
    expect(messagesOf(report)).toContain('"* Why"');
  });

  it('reads a Markdown proposal exactly as before (control, both signs)', async () => {
    const withWhy = await change('mdok', 'proposal.md', MD_PROPOSAL, 'spec.md', MD_DELTA);
    const without = await change('mdbad', 'proposal.md', MD_PROPOSAL_NO_WHY, 'spec.md', MD_DELTA);

    expect(messagesOf(await new Validator().validateChange(withWhy))).not.toMatch(MISSING_WHY);
    expect(messagesOf(await new Validator().validateChange(without))).toMatch(MISSING_WHY);
  });

  it('reads an org proposal as Markdown when no format is passed (unresolved callers unchanged)', async () => {
    // The default is Markdown by design (ChangeParser's constructor note), and
    // that default is what made the defect invisible: it is asserted, not left
    // to be rediscovered.
    const proposal = await change('probe', 'proposal.org', ORG_PROPOSAL, 'spec.org', ORG_DELTA);

    expect(messagesOf(await new Validator().validateChange(proposal))).toMatch(MISSING_WHY);
  });
});
