import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { discoverSpecFiles } from '../../src/utils/spec-discovery.js';
import { resolveFormat } from '../../src/core/parsers/grammar.js';

const ORG = resolveFormat({ format: { markup: 'org' } });
const MARKDOWN = resolveFormat();

describe('org: spec discovery follows the artifact format', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-discovery-'));
    // Both files exist side by side in each capability, so a discovery that
    // ignored the format would still find something and read "green".
    for (const capability of ['data-export', 'identity/session']) {
      const dir = path.join(root, capability);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'spec.org'), '* Purpose\n');
      await fs.writeFile(path.join(dir, 'spec.md'), '## Purpose\n');
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds spec.org and only spec.org for an org artifact', async () => {
    // Reddens if discovery goes back to the hard-coded `spec.md`: the ids stay
    // the same but every path ends in the wrong extension.
    const discovered = await discoverSpecFiles(root, ORG);

    expect(discovered.map(spec => spec.id)).toEqual(['data-export', 'identity/session']);
    expect(discovered.map(spec => path.basename(spec.specFile))).toEqual(['spec.org', 'spec.org']);
  });

  it('finds spec.md and only spec.md when nothing is declared (control)', async () => {
    // The must-stay-green twin: the undeclared path is what every existing
    // project runs on, so it must not follow the org branch.
    const discovered = await discoverSpecFiles(root, MARKDOWN);

    expect(discovered.map(spec => path.basename(spec.specFile))).toEqual(['spec.md', 'spec.md']);
    expect(await discoverSpecFiles(root)).toEqual(discovered);
  });

  it('reports no org specs when only markdown ones exist', async () => {
    const mdOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-discovery-md-'));
    try {
      await fs.mkdir(path.join(mdOnly, 'legacy'), { recursive: true });
      await fs.writeFile(path.join(mdOnly, 'legacy', 'spec.md'), '## Purpose\n');

      // The zero here is only meaningful next to the control below, which
      // proves the same call shape does find a file in this very directory.
      expect(await discoverSpecFiles(mdOnly, ORG)).toEqual([]);
      expect((await discoverSpecFiles(mdOnly, MARKDOWN)).map(spec => spec.id)).toEqual(['legacy']);
    } finally {
      await fs.rm(mdOnly, { recursive: true, force: true });
    }
  });
});
