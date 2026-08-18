import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  buildUpdatedSpec,
  findSpecUpdates,
  writeUpdatedSpec,
} from '../../src/core/specs-apply.js';
import { Validator } from '../../src/core/validation/validator.js';
import { resolveFormat } from '../../src/core/parsers/grammar.js';

const ORG = resolveFormat({ format: { markup: 'org' } });
const CAPABILITY = 'data-export';

/**
 * ADDED -> MODIFIED + RENAMED -> REMOVED against `spec.org`, the cycle the plan
 * names as the org set's centre. Each phase asserts what the NEXT phase needs,
 * so a merge that writes plausible-looking text the following phase cannot read
 * fails here rather than in a user's repository.
 */
describe('org: the delta cycle merges into spec.org', () => {
  let root: string;
  let changeDir: string;
  let mainSpecsDir: string;

  const deltaFile = () => path.join(changeDir, 'specs', CAPABILITY, 'spec.org');
  const mainSpec = () => path.join(mainSpecsDir, CAPABILITY, 'spec.org');

  async function writeDelta(body: string): Promise<void> {
    await fs.mkdir(path.dirname(deltaFile()), { recursive: true });
    await fs.writeFile(deltaFile(), body);
  }

  /** Apply whatever delta is on disk, returning the merged main spec. */
  async function apply(): Promise<string> {
    const updates = await findSpecUpdates(changeDir, mainSpecsDir, ORG);
    expect(updates).toHaveLength(1);
    const [update] = updates;
    const { rebuilt, counts } = await buildUpdatedSpec(update, 'add-export', { silent: true }, ORG);
    await writeUpdatedSpec(update, rebuilt, counts, { silent: true }, ORG);
    return fs.readFile(mainSpec(), 'utf-8');
  }

  function requirementIds(spec: string): string[] {
    return [...spec.matchAll(/^:ID:\s+(\S+)\s*$/gimu)].map(match => match[1]);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-cycle-'));
    changeDir = path.join(root, 'openspec', 'changes', 'add-export');
    mainSpecsDir = path.join(root, 'openspec', 'specs');
    await fs.mkdir(mainSpecsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the main spec from ADDED, emitting org headers and minting an :ID:', async () => {
    await writeDelta(
      [
        '* Purpose',
        '',
        'Lets users take their data out of the product in a portable, documented format.',
        '',
        '* ADDED Requirements',
        '',
        '** Requirement: User can export data',
        'The system SHALL allow users to export their data in CSV format.',
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes a CSV file',
        '',
      ].join('\n')
    );

    const merged = await apply();

    // Emission axis (plan §1 row 9, §5 must-redden 6): the headers written here
    // come from code, not from a template, so a missed emitter shows up as a
    // markdown header inside a `.org` file that then fails to re-parse.
    expect(merged).toMatch(/^\*\* Requirement: User can export data$/mu);
    expect(merged).toMatch(/^\*{3} Scenario: Successful export$/mu);
    expect(merged).not.toContain('### Requirement:');
    expect(merged).not.toContain('#### Scenario:');
    expect(merged).toContain('#+TITLE:');

    expect(requirementIds(merged)).toEqual([`req-${CAPABILITY}-user-can-export-data`]);

    // What the next phase depends on: the merged spec must read back.
    expect((await new Validator(true).validateSpecContent(CAPABILITY, merged, ORG)).valid).toBe(
      true
    );
  });

  it('carries the minted :ID: through MODIFIED and through a RENAMED title', async () => {
    await writeDelta(
      [
        '* Purpose',
        '',
        'Lets users take their data out of the product in a portable, documented format.',
        '',
        '* ADDED Requirements',
        '',
        '** Requirement: User can export data',
        'The system SHALL allow users to export their data in CSV format.',
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes a CSV file',
        '',
      ].join('\n')
    );
    const created = await apply();
    const mintedId = requirementIds(created)[0];
    expect(mintedId).toBe(`req-${CAPABILITY}-user-can-export-data`);

    await writeDelta(
      [
        '* MODIFIED Requirements',
        '',
        // Upstream requires MODIFIED to name the POST-rename header when a
        // rename is present in the same delta; the org reader must apply that
        // same rule to `** Requirement:` lines.
        '** Requirement: User can export data in any format',
        'The system SHALL allow users to export their data in CSV and JSON format.',
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes the requested format',
        '',
        '* RENAMED Requirements',
        '',
        '- FROM: ** Requirement: User can export data',
        '- TO: ** Requirement: User can export data in any format',
        '',
      ].join('\n')
    );

    const renamed = await apply();

    expect(renamed).toMatch(/^\*\* Requirement: User can export data in any format$/mu);
    expect(renamed).toContain('CSV and JSON');
    // The pin (plan §3(а)): a rename changes the title, never the identity. If
    // the slug were re-derived from the new title this would read
    // `req-data-export-user-can-export-data-in-any-format` and every existing
    // `[[id:...]]` link into this requirement would dangle.
    expect(requirementIds(renamed)).toEqual([mintedId]);
    expect((await new Validator(true).validateSpecContent(CAPABILITY, renamed, ORG)).valid).toBe(
      true
    );
  });

  it('emits the new header itself when RENAMED arrives without a MODIFIED body', async () => {
    // The emitter lock (plan §1 row 9). In the test above, MODIFIED supplies
    // its own `** Requirement:` line and overwrites the renamed header, so that
    // test cannot see a broken emitter. Here the header written to disk comes
    // only from `format.requirementHeaderLine`, so pointing that token at the
    // markdown shape reddens this and nothing else.
    await writeDelta(
      [
        '* Purpose',
        '',
        'Lets users take their data out of the product in a portable, documented format.',
        '',
        '* ADDED Requirements',
        '',
        '** Requirement: User can export data',
        'The system SHALL allow users to export their data in CSV format.',
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes a CSV file',
        '',
      ].join('\n')
    );
    await apply();

    await writeDelta(
      [
        '* RENAMED Requirements',
        '',
        '- FROM: ** Requirement: User can export data',
        '- TO: ** Requirement: User can export data in any format',
        '',
      ].join('\n')
    );

    const renamed = await apply();

    expect(renamed).toMatch(/^\*\* Requirement: User can export data in any format$/mu);
    expect(renamed).not.toContain('### Requirement:');
    expect(requirementIds(renamed)).toEqual([`req-${CAPABILITY}-user-can-export-data`]);
    expect((await new Validator(true).validateSpecContent(CAPABILITY, renamed, ORG)).valid).toBe(
      true
    );
  });

  it('drops the requirement on REMOVED', async () => {
    await writeDelta(
      [
        '* Purpose',
        '',
        'Lets users take their data out of the product in a portable, documented format.',
        '',
        '* ADDED Requirements',
        '',
        '** Requirement: User can export data',
        'The system SHALL allow users to export their data in CSV format.',
        '',
        '*** Scenario: Successful export',
        '- *WHEN* the user asks for an export',
        '- *THEN* the system writes a CSV file',
        '',
        '** Requirement: Export is audited',
        'The system SHALL record every export in the audit log.',
        '',
        '*** Scenario: Audited export',
        '- *WHEN* an export finishes',
        '- *THEN* an audit entry exists',
        '',
      ].join('\n')
    );
    const created = await apply();
    expect(requirementIds(created)).toHaveLength(2);

    await writeDelta(
      [
        '* REMOVED Requirements',
        '',
        '** Requirement: Export is audited',
        '*Reason*: folded into the platform audit trail',
        '*Migration*: read the platform audit log instead',
        '',
      ].join('\n')
    );

    const afterRemoval = await apply();

    expect(afterRemoval).not.toContain('Export is audited');
    expect(requirementIds(afterRemoval)).toEqual([`req-${CAPABILITY}-user-can-export-data`]);
    expect(
      (await new Validator(true).validateSpecContent(CAPABILITY, afterRemoval, ORG)).valid
    ).toBe(true);
  });

  it('reddens when the delta is written in markdown (control on the whole cycle)', async () => {
    await writeDelta(
      [
        '## Purpose',
        '',
        'Lets users take their data out of the product in a portable, documented format.',
        '',
        '## ADDED Requirements',
        '',
        '### Requirement: User can export data',
        'The system SHALL allow users to export their data in CSV format.',
        '',
        '#### Scenario: Successful export',
        '- **WHEN** the user asks for an export',
        '- **THEN** the system writes a CSV file',
        '',
      ].join('\n')
    );

    // The file is named spec.org and IS discovered, so this is not a discovery
    // miss: the org reader finds no delta section in markdown text and refuses
    // loudly. A merge that "succeeded" here would mean the org anchors had
    // quietly kept their markdown alternatives, and the change would archive
    // into a spec nobody wrote.
    const updates = await findSpecUpdates(changeDir, mainSpecsDir, ORG);
    expect(updates).toHaveLength(1);
    await expect(
      buildUpdatedSpec(updates[0], 'add-export', { silent: true }, ORG)
    ).rejects.toThrow(/no operations/i);
  });
});
