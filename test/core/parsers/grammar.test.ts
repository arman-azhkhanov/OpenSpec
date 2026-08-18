import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectFormatIssues,
  defaultFormat,
  requirementSlug,
  resolveFormat,
  type ResolvedFormat,
} from '../../../src/core/parsers/grammar.js';
import { containsShallOrMust } from '../../../src/core/parsers/requirement-text.js';
import { ChangeParser } from '../../../src/core/parsers/change-parser.js';
import { JsonConverter } from '../../../src/core/converters/json-converter.js';
import { extractFirstPurposeLine } from '../../../src/core/references.js';
import { isKebabId } from '../../../src/core/id.js';
import { parseSchema, SchemaValidationError } from '../../../src/core/artifact-graph/schema.js';
import type { Artifact } from '../../../src/core/artifact-graph/types.js';

const orgArtifact = { format: { markup: 'org' } } as const;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function schemaYaml(artifacts: string): string {
  return `
name: fixture-schema
version: 1
artifacts:
${artifacts}
`;
}

const PLAIN_ARTIFACT = `  - id: specs
    generates: specs/**/*.md
    description: Capability specs
    template: templates/spec.md
`;

describe('parsers/grammar', () => {
  describe('markdown defaults', () => {
    const format = resolveFormat();

    it('resolves to markdown when nothing is declared', () => {
      // Reddens if an undeclared artifact stops resolving to today's literals —
      // the one promise this module makes to existing projects.
      expect(format.markup).toBe('markdown');
      expect(format.SPEC_FILE).toBe('spec.md');
      expect(resolveFormat({})).toBe(format);
      expect(resolveFormat({ format: {} }).markup).toBe('markdown');
      expect(resolveFormat(null)).toBe(defaultFormat());
    });

    it('recognizes the markdown structure the parsers carried before', () => {
      expect(format.H2_REQUIREMENTS.test('## Requirements')).toBe(true);
      expect(format.H2_PURPOSE.test('## Purpose')).toBe(true);
      expect('### Requirement: The system SHALL log'.match(format.H3_REQUIREMENT)?.[1].trim()).toBe(
        'The system SHALL log'
      );
      expect(format.H4_SCENARIO.test('#### Scenario: Happy path')).toBe(true);
      expect('## ADDED Requirements'.match(format.H2_DELTA)?.[1]).toBe('ADDED');
      expect(format.headingLevel('## Requirements')).toBe(2);
      expect(format.headingLevel('#### Scenario: X')).toBe(4);
    });

    it('does not recognize org structure', () => {
      // Reddens if the markdown family silently starts accepting org markup,
      // which would make the two families indistinguishable.
      expect(format.H2_REQUIREMENTS.test('* Requirements')).toBe(false);
      expect(format.H3_REQUIREMENT.test('** Requirement: X')).toBe(false);
      expect(format.headingLevel('* Requirements')).toBe(null);
      expect(format.FENCE_OPEN.test('#+begin_src ts')).toBe(false);
    });

    it('keeps the markdown checkbox, bullet and fence classes', () => {
      expect(format.TASK_LINE.test('- [x] done')).toBe(true);
      expect(format.TASK_LINE.test('- [ ] open')).toBe(true);
      // `[-]` is NOT a markdown checkbox: adding it here would change upstream
      // task counting, which this work must not do.
      expect(format.TASK_LINE.test('- [-] org-only')).toBe(false);
      expect(format.CHECKBOX_CLASS).toBe('[\\sxX]');
      expect(format.LIST_BULLET.test('* item')).toBe(true);
      expect(format.FENCE_OPEN.test('```ts')).toBe(true);
      expect(format.fenceMasksHeadings).toBe(true);
      expect(format.PROPERTIES_OPEN).toBe(null);
      expect(format.ID_PROPERTY).toBe(null);
    });

    it('emits the markdown shapes the emitters wrote before', () => {
      expect(format.newSpecHeader('billing')).toBe('# billing Specification');
      expect(format.requirementsSectionLine()).toBe('## Requirements');
      expect(format.purposeSectionLine()).toBe('## Purpose');
      expect(format.deltaSectionLine('RENAMED')).toBe('## RENAMED Requirements');
      expect(format.requirementHeaderLine('Users log in')).toBe('### Requirement: Users log in');
      expect(format.scenarioHeaderLine('Happy path')).toBe('#### Scenario: Happy path');
    });

    it('reproduces the historical markdown regexes, written out as literals', () => {
      // The oracle is written out HERE on purpose. `SCENARIO_HEADER` and
      // `containsShallOrMust` in requirement-text.ts are now aliases OF this
      // format, so asserting against them compares a value with itself and
      // cannot redden — which is exactly what the previous version of this test
      // did, and what that module's own docstring forbids.
      expect(format.H4_SCENARIO.source).toBe('^####\\s+');
      expect(format.H4_SCENARIO.flags).toBe('');
      expect(format.H3_REQUIREMENT.source).toBe('^###\\s+Requirement:\\s*(.+)\\s*$');
      expect(format.H2_REQUIREMENTS.source).toBe('^##\\s+Requirements\\s*$');
      expect(format.H2_DELTA.source).toBe(
        '^##\\s+(ADDED|MODIFIED|REMOVED|RENAMED)\\s+Requirements\\s*$'
      );
      expect(format.TASK_LINE.source).toBe('^\\s*[-*]\\s*\\[([\\sxX])\\]\\s*(.*)');
      expect(format.FENCE_OPEN.source).toBe('^\\s*(`{3,}|~{3,})');
      // Derived title-level recognizer: the delta reader's own literal.
      expect(format.REQUIREMENT_TITLE.source).toBe('^Requirement:\\s*\\S');
    });

    it('detects the normative keywords a literal `\\b(SHALL|MUST)\\b` detects', () => {
      // Same reasoning: the oracle is an independent regex, not the alias.
      const oracle = (text: string) => /\b(SHALL|MUST)\b/.test(text);
      for (const text of [
        'The system SHALL log',
        'The system MUST log',
        'the system shall log',
        'MUSTARD is not a keyword',
        'no keyword at all',
        'SHALL, then MUST',
      ]) {
        expect([text, format.containsNormativeKeyword(text)]).toEqual([text, oracle(text)]);
      }
      // The alias still delegates here — a separate fact, asserted separately.
      expect(containsShallOrMust('The system SHALL log')).toBe(true);
      expect(containsShallOrMust('no keyword at all')).toBe(false);
    });
  });

  describe('org markup', () => {
    const format = resolveFormat(orgArtifact);

    it('resolves the org family and its spec file', () => {
      expect(format.markup).toBe('org');
      expect(format.SPEC_FILE).toBe('spec.org');
    });

    it('recognizes org structure at markdown-numbered depths', () => {
      expect(format.H2_REQUIREMENTS.test('* Requirements')).toBe(true);
      expect(format.H2_PURPOSE.test('* Purpose')).toBe(true);
      expect('** Requirement: The system SHALL log'.match(format.H3_REQUIREMENT)?.[1].trim()).toBe(
        'The system SHALL log'
      );
      expect(format.H4_SCENARIO.test('*** Scenario: Happy path')).toBe(true);
      expect('* ADDED Requirements'.match(format.H2_DELTA)?.[1]).toBe('ADDED');
      // One star fewer than markdown at the same depth: the document model is
      // unchanged, so a level number means the same thing in both families.
      expect(format.headingLevel('* Requirements')).toBe(2);
      expect(format.headingLevel('** Requirement: X')).toBe(3);
      expect(format.headingLevel('*** Scenario: X')).toBe(4);
    });

    it('does not recognize markdown structure', () => {
      expect(format.H2_REQUIREMENTS.test('## Requirements')).toBe(false);
      expect(format.H3_REQUIREMENT.test('### Requirement: X')).toBe(false);
      expect(format.headingLevel('## Requirements')).toBe(null);
      expect(format.FENCE_OPEN.test('```ts')).toBe(false);
    });

    it('counts an org in-progress checkbox and refuses `*` as a bullet', () => {
      expect(format.TASK_LINE.test('- [-] in progress')).toBe(true);
      expect(format.TASK_LINE.test('+ [X] done')).toBe(true);
      expect(format.CHECKBOX_CLASS).toBe('[\\sxX-]');
      // `*` at line start is a heading in org, never a list bullet.
      expect(format.LIST_BULLET.test('* item')).toBe(false);
      expect(format.LIST_BULLET.test('- item')).toBe(true);
      expect(format.LIST_BULLET.test('+ item')).toBe(true);
    });

    it('fences org blocks without letting them hide headings', () => {
      expect(format.FENCE_OPEN.test('#+begin_src clojure')).toBe(true);
      expect(format.FENCE_CLOSE.test('#+end_src')).toBe(true);
      expect(format.FENCE_OPEN.test('#+begin_example')).toBe(true);
      // A star line is structure even inside a block, so Org's own comma
      // escape — not the fence — is what keeps an example heading out of the
      // parse. Nothing escapes on the author's behalf, so the property under
      // lock is RECOGNITION: both signs, on the same line.
      expect(format.fenceMasksHeadings).toBe(false);
      expect(format.H2_REQUIREMENTS.test(',* Requirements')).toBe(false);
      expect(format.H2_REQUIREMENTS.test('* Requirements')).toBe(true);
      expect(format.H3_REQUIREMENT.test(',** Requirement: Illustration only')).toBe(false);
      expect(format.H3_REQUIREMENT.test('** Requirement: Illustration only')).toBe(true);
      expect(format.HEADING_ANY.test(',** Requirement: Illustration only')).toBe(false);
    });

    it('reads and mints org identity', () => {
      expect(format.PROPERTIES_OPEN?.test(':PROPERTIES:')).toBe(true);
      expect(format.DRAWER_END?.test(':END:')).toBe(true);
      expect(':ID: req-billing-users-log-in'.match(format.ID_PROPERTY!)?.[1]).toBe(
        'req-billing-users-log-in'
      );
      const id = format.requirementId('billing', 'Users log in');
      expect(id).toBe('req-billing-users-log-in');
      expect(isKebabId(id)).toBe(true);
      // A title with no Latin characters still mints a legal id.
      expect(isKebabId(format.requirementId('billing', 'Система должна'))).toBe(true);
    });

    it('emits the org shapes', () => {
      expect(format.newSpecHeader('billing')).toBe('#+TITLE: billing Specification');
      expect(format.requirementsSectionLine()).toBe('* Requirements');
      expect(format.deltaSectionLine('RENAMED')).toBe('* RENAMED Requirements');
      expect(format.requirementHeaderLine('Users log in')).toBe('** Requirement: Users log in');
      expect(format.scenarioHeaderLine('Happy path')).toBe('*** Scenario: Happy path');
    });

    it('judges a parsed section title by the org token, marker already gone', () => {
      // Both signs: the section titles a reader sees have had `**` stripped.
      expect(format.REQUIREMENT_TITLE.test('Requirement: User can export data')).toBe(true);
      expect(format.REQUIREMENT_TITLE.test('Documentation Requirements')).toBe(false);
      expect(format.REQUIREMENT_TITLE.test('Requirement:')).toBe(false);
      // Derived from the token, so a declared header is judged by its own words.
      const declared = resolveFormat({
        format: { markup: 'org', requirementHeader: '** Functional  Requirement: {name}' },
      });
      expect(declared.REQUIREMENT_TITLE.test('Functional Requirement: Login')).toBe(true);
      expect(declared.REQUIREMENT_TITLE.test('Requirement: Login')).toBe(false);
    });
  });

  describe('reader and writer agree within one format', () => {
    const cases: Array<[string, ResolvedFormat]> = [
      ['markdown', resolveFormat()],
      ['org', resolveFormat(orgArtifact)],
    ];

    it.each(cases)('%s emits what it recognizes', (_name, format) => {
      // The invariant that keeps validate and archive from disagreeing: what a
      // format writes, the same format reads back with the same name.
      const header = format.requirementHeaderLine('Users log in');
      expect(header.match(format.H3_REQUIREMENT)?.[1].trim()).toBe('Users log in');
      expect(format.H2_REQUIREMENTS.test(format.requirementsSectionLine())).toBe(true);
      expect(format.H2_PURPOSE.test(format.purposeSectionLine())).toBe(true);
      expect(format.H4_SCENARIO.test(format.scenarioHeaderLine('Happy path'))).toBe(true);
      for (const operation of ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] as const) {
        expect(format.deltaSectionLine(operation).match(format.H2_DELTA)?.[1]).toBe(operation);
      }
    });
  });

  describe('declared tokens', () => {
    it('replaces only the token it declares', () => {
      const format = resolveFormat({
        format: { requirementHeader: '## Functional Requirement: {name}' },
      });
      expect('## Functional Requirement: Login'.match(format.H3_REQUIREMENT)?.[1].trim()).toBe(
        'Login'
      );
      expect(format.H3_REQUIREMENT.test('### Requirement: Login')).toBe(false);
      // Undeclared fields keep the built-in defaults.
      expect(format.H2_REQUIREMENTS.test('## Requirements')).toBe(true);
      expect(format.requirementHeaderLine('Login')).toBe('## Functional Requirement: Login');
    });

    it('tolerates whitespace runs in a declared token', () => {
      const format = resolveFormat({ format: { requirementsSection: '## Functional Requirements' } });
      expect(format.H2_REQUIREMENTS.test('##   Functional   Requirements')).toBe(true);
      expect(format.H2_REQUIREMENTS.test('## Requirements')).toBe(false);
    });

    it('compiles normative keywords from literals only', () => {
      const format = resolveFormat({ format: { normativeKeywords: ['ДОЛЖЕН', 'SHALL'] } });
      // Reddens if declared keywords are compiled with ASCII `\b`, which makes
      // a non-English keyword match nothing at all — silently.
      expect(format.containsNormativeKeyword('Система ДОЛЖЕН логировать')).toBe(true);
      expect(format.containsNormativeKeyword('Система должна логировать')).toBe(false);
      expect(format.containsNormativeKeyword('The system SHALL log')).toBe(true);
      expect(format.containsNormativeKeyword('The system ought to log')).toBe(false);
      // A keyword is never interpolated as a pattern.
      const literal = resolveFormat({ format: { normativeKeywords: ['A.C'] } });
      expect(literal.containsNormativeKeyword('A.C')).toBe(true);
      expect(literal.containsNormativeKeyword('ABC')).toBe(false);
    });

    it('leaves the undeclared predicate on the built-in ASCII boundary', () => {
      // The two boundary rules disagree only where a keyword abuts a non-ASCII
      // letter. The undeclared path must keep the upstream answer; the declared
      // path is new surface and reads the keyword as one word.
      const probe = 'SHALLЖ';
      expect(containsShallOrMust(probe)).toBe(true);
      expect(defaultFormat().containsNormativeKeyword(probe)).toBe(true);
      expect(resolveFormat({ format: { normativeKeywords: ['SHALL'] } }).containsNormativeKeyword(probe)).toBe(
        false
      );
    });
  });

  describe('two artifacts, two formats', () => {
    it('resolves each artifact to its own format and neither overrides the other', () => {
      const schema = parseSchema(
        schemaYaml(`  - id: specs
    generates: specs/**/*.md
    description: Markdown specs
    template: templates/spec.md
  - id: org-specs
    generates: specs/**/*.org
    description: Org specs
    template: templates/spec.org
    format:
      markup: org
`)
      );

      const [md, org] = schema.artifacts;
      const mdFormat = resolveFormat(md);
      const orgFormat = resolveFormat(org);

      expect(mdFormat.markup).toBe('markdown');
      expect(orgFormat.markup).toBe('org');

      // Resolving the second must not have disturbed the first: reddens the
      // moment resolution grows any process-wide state.
      expect(resolveFormat(md).SPEC_FILE).toBe('spec.md');
      expect(mdFormat.H3_REQUIREMENT.test('### Requirement: X')).toBe(true);
      expect(mdFormat.H3_REQUIREMENT.test('** Requirement: X')).toBe(false);
      expect(orgFormat.H3_REQUIREMENT.test('** Requirement: X')).toBe(true);
      expect(orgFormat.H3_REQUIREMENT.test('### Requirement: X')).toBe(false);
    });
  });

  describe('an ill-formed block is rejected at load, not dropped', () => {
    function artifactWithFormat(block: string): string {
      return `  - id: specs
    generates: specs/**/*.md
    description: Capability specs
    template: templates/spec.md
    format:
${block}`;
    }

    it('accepts a well-formed declaration (control)', () => {
      const schema = parseSchema(
        schemaYaml(
          artifactWithFormat(`      markup: org
      requirementHeader: '** Requirement: {name}'
      normativeKeywords: [SHALL, MUST]
`)
        )
      );
      expect(schema.artifacts[0].format?.markup).toBe('org');
      expect(resolveFormat(schema.artifacts[0]).SPEC_FILE).toBe('spec.org');
    });

    it('accepts a schema with no format block at all (control)', () => {
      const schema = parseSchema(schemaYaml(PLAIN_ARTIFACT));
      expect(schema.artifacts[0].format).toBeUndefined();
      expect(resolveFormat(schema.artifacts[0])).toBe(defaultFormat());
    });

    it('reports an unknown key inside the block instead of stripping it', () => {
      const yaml = schemaYaml(
        artifactWithFormat(`      requirementHeader: '### Requirement: {name}'
      bogusKey: nope
`)
      );
      expect(() => parseSchema(yaml)).toThrow(SchemaValidationError);
      expect(() => parseSchema(yaml)).toThrow(/bogusKey/);
      expect(() => parseSchema(yaml)).toThrow(/artifact 'specs'/);
    });

    it('reports a header token with no {name} placeholder', () => {
      const yaml = schemaYaml(artifactWithFormat(`      requirementHeader: '### Requirement:'\n`));
      expect(() => parseSchema(yaml)).toThrow(SchemaValidationError);
      expect(() => parseSchema(yaml)).toThrow(/requirementHeader/);
      expect(() => parseSchema(yaml)).toThrow(/artifact 'specs'/);
      expect(() => parseSchema(yaml)).toThrow(/\{name\}/);
    });

    it('reports a scenario token with no {name} placeholder', () => {
      const yaml = schemaYaml(artifactWithFormat(`      scenarioHeader: '#### Scenario:'\n`));
      expect(() => parseSchema(yaml)).toThrow(/scenarioHeader/);
    });

    it('reports a delta token with no {operation} placeholder', () => {
      const yaml = schemaYaml(artifactWithFormat(`      deltaSection: '## Requirements'\n`));
      expect(() => parseSchema(yaml)).toThrow(/deltaSection/);
      expect(() => parseSchema(yaml)).toThrow(/\{operation\}/);
    });

    it('reports empty normative keywords', () => {
      const yaml = schemaYaml(artifactWithFormat(`      normativeKeywords: []\n`));
      expect(() => parseSchema(yaml)).toThrow(SchemaValidationError);
      expect(() => parseSchema(yaml)).toThrow(/normativeKeywords/);
    });

    it('reports two declared tokens with the same shape', () => {
      const yaml = schemaYaml(
        artifactWithFormat(`      requirementHeader: '### Item: {name}'
      scenarioHeader: '### Item: {name}'
`)
      );
      expect(() => parseSchema(yaml)).toThrow(SchemaValidationError);
      expect(() => parseSchema(yaml)).toThrow(/same token/);
    });

    it('names every issue of a block through collectFormatIssues', () => {
      const artifact = {
        id: 'specs',
        generates: 'specs/**/*.md',
        description: '',
        template: 'templates/spec.md',
        requires: [],
        format: {
          requirementHeader: '### Requirement:',
          scenarioHeader: '   ',
          normativeKeywords: ['', 'SHALL'],
        },
      } as Artifact;

      const issues = collectFormatIssues(artifact);
      expect(issues).toHaveLength(4);
      expect(issues.every(issue => issue.includes("artifact 'specs'"))).toBe(true);
      expect(issues.filter(issue => issue.includes('requirementHeader'))).toHaveLength(1);
      expect(issues.filter(issue => issue.includes('scenarioHeader'))).toHaveLength(2);
      expect(issues.filter(issue => issue.includes('normativeKeywords'))).toHaveLength(1);
      // Control: the same artifact without the block reports nothing.
      expect(collectFormatIssues({ ...artifact, format: undefined })).toEqual([]);
    });
  });

  describe('requirementSlug', () => {
    it('produces the repository kebab grammar', () => {
      expect(requirementSlug('Users log in')).toBe('users-log-in');
      expect(requirementSlug('  Spaced -- out  ')).toBe('spaced-out');
      expect(isKebabId(requirementSlug('Пользователь входит'))).toBe(true);
      expect(requirementSlug('Same title')).toBe(requirementSlug('Same title'));
    });
  });
});

/**
 * Consumers of the module, at the seam where a format either reaches them or
 * does not. A resolved format that nothing hands to the reader is the failure
 * these lock: the primitive is right and the caller still reads Markdown.
 */
describe('parsers/grammar reaches its consumers', () => {
  const sandboxes: string[] = [];

  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  function writeChange(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'grammar-consumers-'));
    sandboxes.push(root);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
    return root;
  }

  describe('ChangeParser reads a change in the format it is handed', () => {
    const ORG_PROPOSAL = [
      '#+TITLE: Add data export',
      '',
      '* Why',
      '',
      'Users cannot take their data out of the product today.',
      '',
      '* What Changes',
      '',
      '- Add a CSV export endpoint.',
      '',
    ].join('\n');

    const ORG_DELTA = [
      '* ADDED Requirements',
      '',
      '** Documentation Requirements',
      'A divider header, not a requirement.',
      '',
      '** Requirement: User can export data',
      'The system SHALL allow users to export their data in CSV format.',
      '',
      '*** Scenario: Successful export',
      '- *WHEN* the user asks for an export',
      '- *THEN* the system writes a CSV file',
      '',
      '* RENAMED Requirements',
      '',
      '- FROM: ** Requirement: Old name',
      '- TO: ** Requirement: New name',
      '',
    ].join('\n');

    const MD_PROPOSAL = ORG_PROPOSAL.replace('#+TITLE: Add data export', '# Add data export')
      .replace('* Why', '## Why')
      .replace('* What Changes', '## What Changes');

    const MD_DELTA = [
      '## ADDED Requirements',
      '',
      '### Documentation Requirements',
      'A divider header, not a requirement.',
      '',
      '### Requirement: User can export data',
      'The system SHALL allow users to export their data in CSV format.',
      '',
      '#### Scenario: Successful export',
      '- **WHEN** the user asks for an export',
      '- **THEN** the system writes a CSV file',
      '',
      '## RENAMED Requirements',
      '',
      '- FROM: `### Requirement: Old name`',
      '- TO: `### Requirement: New name`',
      '',
    ].join('\n');

    it('parses an org change end to end when the org format is passed', async () => {
      const dir = writeChange({
        'proposal.org': ORG_PROPOSAL,
        'specs/data-export/spec.org': ORG_DELTA,
      });

      const change = await new ChangeParser(
        ORG_PROPOSAL,
        dir,
        resolveFormat(orgArtifact)
      ).parseChangeWithDeltas('add-export');

      expect(change.why).toContain('Users cannot take their data out');
      expect(change.whatChanges).toContain('CSV export endpoint');
      // The divider header is NOT a requirement, judged by the org token.
      expect(change.deltas.map(delta => delta.operation).sort()).toEqual(['ADDED', 'RENAMED']);
      expect(change.deltas[0].requirement?.text).toContain('CSV format');
      expect(change.deltas[0].requirement?.scenarios).toHaveLength(1);
      expect(change.deltas[1].rename).toEqual({ from: 'Old name', to: 'New name' });
    });

    it('refuses the same org change when handed the markdown default (the other sign)', async () => {
      const dir = writeChange({
        'proposal.org': ORG_PROPOSAL,
        'specs/data-export/spec.org': ORG_DELTA,
      });

      // This is the failure `show --json --deltas-only` reported on an org
      // change: `* Why` is invisible to a reader running markdown recognizers.
      await expect(
        new ChangeParser(ORG_PROPOSAL, dir).parseChangeWithDeltas('add-export')
      ).rejects.toThrow('Change must have a Why section');
    });

    it('carries the format through JsonConverter, which is what `show --json` calls', async () => {
      // The seam `show --json --deltas-only` reported broken: the converter is
      // the only thing between the command and the parser, so a format that
      // stops here leaves the CLI reading markdown recognizers.
      const dir = writeChange({
        'proposal.org': ORG_PROPOSAL,
        'specs/data-export/spec.org': ORG_DELTA,
      });
      const proposalPath = path.join(dir, 'proposal.org');
      const converter = new JsonConverter();

      const parsed = JSON.parse(
        await converter.convertChangeToJson(proposalPath, resolveFormat(orgArtifact))
      );
      expect(parsed.deltas).toHaveLength(2);
      expect(parsed.why).toContain('Users cannot take their data out');

      // The other sign, and the exact CLI symptom.
      await expect(converter.convertChangeToJson(proposalPath)).rejects.toThrow(
        'Change must have a Why section'
      );
    });

    it('reads a markdown change exactly as before (control)', async () => {
      const dir = writeChange({
        'proposal.md': MD_PROPOSAL,
        'specs/data-export/spec.md': MD_DELTA,
      });

      const change = await new ChangeParser(MD_PROPOSAL, dir).parseChangeWithDeltas('add-export');

      expect(change.why).toContain('Users cannot take their data out');
      expect(change.deltas.map(delta => delta.operation).sort()).toEqual(['ADDED', 'RENAMED']);
      expect(change.deltas[0].requirement?.text).toContain('CSV format');
      expect(change.deltas[1].rename).toEqual({ from: 'Old name', to: 'New name' });
    });
  });

  describe('extractFirstPurposeLine keeps the markdown answer it always gave', () => {
    /**
     * The oracle: this file's ORIGINAL markdown loop, transcribed. It closes a
     * fence on the marker KIND alone, which is looser than the shared
     * CommonMark mask — and that difference is the whole point of the lock.
     */
    function historicalMarkdownScan(markdown: string): string {
      const lines = markdown.split(/\r?\n/);
      let inPurpose = false;
      let fenceMarker: string | null = null;
      for (const line of lines) {
        const fence = line.match(/^\s*(```|~~~)/);
        if (fence) {
          if (fenceMarker === null) fenceMarker = fence[1];
          else if (fence[1] === fenceMarker) fenceMarker = null;
          continue;
        }
        if (fenceMarker !== null) continue;
        let level = 0;
        while (level < 6 && level < line.length && line[level] === '#') level++;
        const isHeading = level > 0 && level < line.length && /\s/.test(line[level]);
        if (isHeading) {
          if (inPurpose) return '';
          inPurpose = line.slice(level).trim().replace(/\s+#+$/, '').toLowerCase() === 'purpose';
          continue;
        }
        if (inPurpose && line.trim().length > 0) return line.trim();
      }
      return '';
    }

    const corpus: Array<[string, string]> = [
      ['plain', '## Purpose\n\nThe real summary.\n\n## Requirements\n'],
      ['fence before the line', '## Purpose\n\n```\nfenced\n```\nThe real summary.\n'],
      ['tilde fence', '## Purpose\n\n~~~\nfenced\n~~~\nThe real summary.\n'],
      [
        'long fence closed by a short one',
        '## Purpose\n\n`````\ninner\n```\nleaked line\n`````\nThe real summary.\n',
      ],
      [
        'info string on the closer',
        '## Purpose\n\n```\ninner\n```js\nleaked line\n```\nThe real summary.\n',
      ],
      ['mismatched marker kinds', '## Purpose\n\n```\ninner\n~~~\nstill inner\n```\nafter.\n'],
      ['closing hashes', '## Purpose ##\n\nThe real summary.\n'],
      ['empty purpose', '## Purpose\n\n## Requirements\n'],
      ['no purpose at all', '# Title\n\n## Requirements\n'],
      ['purpose inside a fence', '```\n## Purpose\nnot this\n```\n## Purpose\nThis one.\n'],
    ];

    it.each(corpus)('markdown byte-parity: %s', (_name, input) => {
      expect(extractFirstPurposeLine(input)).toBe(historicalMarkdownScan(input));
    });

    it('is not a vacuous lock: the oracle and the shared CommonMark mask disagree', () => {
      // Names what SHOULD have reddened this pair. Routing markdown through the
      // shared mask returns 'The real summary.' for both of these.
      const longFence = corpus[3][1];
      const infoCloser = corpus[4][1];
      expect(historicalMarkdownScan(longFence)).toBe('leaked line');
      expect(historicalMarkdownScan(infoCloser)).toBe('leaked line');
      expect(extractFirstPurposeLine(longFence)).toBe('leaked line');
      expect(extractFirstPurposeLine(infoCloser)).toBe('leaked line');
    });

    it('reads an org spec through the org headings and fences (the other family)', () => {
      const org = [
        '#+TITLE: data-export Specification',
        '',
        '* Purpose',
        'Lets users take their data out of the product.',
        '',
        '* Requirements',
      ].join('\n');
      expect(extractFirstPurposeLine(org, resolveFormat(orgArtifact))).toBe(
        'Lets users take their data out of the product.'
      );
      // The markdown reader sees no heading at all in the same bytes.
      expect(extractFirstPurposeLine(org)).toBe('');
    });
  });

  describe('the shipped templates speak their own markup', () => {
    function templates(schema: string, extension: string): Array<[string, string]> {
      const dir = path.join(REPO_ROOT, 'schemas', schema, 'templates');
      return readdirSync(dir)
        .filter(name => name.endsWith(extension))
        .sort()
        .map(name => [name, readFileSync(path.join(dir, name), 'utf-8')]);
    }

    const orgTemplates = templates('ibalta-org', '.org');
    const markdownTemplates = templates('spec-driven', '.md');

    it('finds all four templates in each family (denominator)', () => {
      expect(orgTemplates.map(([name]) => name)).toEqual([
        'design.org',
        'proposal.org',
        'spec.org',
        'tasks.org',
      ]);
      expect(markdownTemplates).toHaveLength(4);
    });

    it.each(orgTemplates)('%s carries no HTML comment', (_name, content) => {
      // `<!-- -->` is invisible in Markdown and ORDINARY TEXT in Org, so a
      // mechanically translated template ships its own instructions into the
      // author's document.
      expect(content).not.toContain('<!--');
      expect(content).not.toContain('-->');
    });

    it('markdown templates still use HTML comments (control for the form above)', () => {
      // Without this the assertion above passes on an empty read just as well.
      expect(markdownTemplates.every(([, content]) => content.includes('<!--'))).toBe(true);
    });

    it('org instruction lines are org comments', () => {
      const commentLines = orgTemplates.flatMap(([name, content]) =>
        content
          .split('\n')
          .filter(line => line.startsWith('#') && !line.startsWith('#+'))
          .map(line => [name, line] as const)
      );
      expect(commentLines.length).toBeGreaterThan(0);
      for (const [, line] of commentLines) expect(line).toMatch(/^# /);
    });

    it('leaves no placeholder standing as an `:ID:` value', () => {
      // A template-minted id would be the SAME id in every file created from
      // it: an org-roam database keyed on that is worse than an empty drawer.
      const spec = orgTemplates.find(([name]) => name === 'spec.org')![1];
      const format = resolveFormat(orgArtifact);
      const idLines = spec.split('\n').filter(line => format.ID_PROPERTY!.test(line));
      expect(idLines).toEqual([]);
      // Control: the drawer itself is still there, waiting to be filled.
      expect(spec.split('\n').some(line => format.PROPERTIES_OPEN!.test(line))).toBe(true);
      expect(spec.split('\n').some(line => line.trim() === ':ID:')).toBe(true);
    });
  });
});
