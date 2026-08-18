import { describe, it, expect } from 'vitest';
import { Validator } from '../../src/core/validation/validator.js';
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
