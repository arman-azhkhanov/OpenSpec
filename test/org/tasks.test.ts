import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  countTasksFromContent,
  getTaskProgressForChange,
  resolveTaskFormatForChange,
} from '../../src/utils/task-progress.js';
import { resolveFormat } from '../../src/core/parsers/grammar.js';

const ORG = resolveFormat({ format: { markup: 'org' } });
const MARKDOWN = resolveFormat();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_ORG_SCHEMA = path.join(REPO_ROOT, 'schemas', 'ibalta-org', 'schema.yaml');

/** One checkbox of each mark: done, Org's in-progress, and open. */
const TASKS_ORG = ['* 1. Setup', '', '- [X] 1.1 done', '- [-] 1.2 in progress', '- [ ] 1.3 open', ''].join(
  '\n'
);

describe('org: the in-progress checkbox counts toward the total (plan §5 must-redden 9)', () => {
  it('counts [-] as an unfinished task in org', () => {
    expect(countTasksFromContent(TASKS_ORG, ORG)).toEqual({ total: 3, completed: 1 });
  });

  it('does not count [-] in markdown, which is the discriminator (control)', () => {
    // The denominator, not the colour, is what moves: markdown's class is
    // `[\sxX]`, so the same three lines are 1/2 there. If org ever fell back to
    // the markdown class this pair collapses to two identical numbers.
    expect(countTasksFromContent(TASKS_ORG, MARKDOWN)).toEqual({ total: 2, completed: 1 });
    expect(countTasksFromContent(TASKS_ORG)).toEqual({ total: 2, completed: 1 });
  });

  it('refuses `*` as a bullet in org, because a star is always a heading', () => {
    // `* [ ] ...` is a heading in org, never a task line. Counting it would let
    // a heading masquerade as work and inflate the denominator silently.
    expect(countTasksFromContent('* [ ] not a task\n- [ ] a task\n', ORG)).toEqual({
      total: 1,
      completed: 0,
    });
    expect(countTasksFromContent('* [ ] a task\n- [ ] a task\n', MARKDOWN)).toEqual({
      total: 2,
      completed: 0,
    });
  });
});

describe('org: apply.tracks selects the tasks artifact (plan §1 row 17, П11)', () => {
  let root: string;
  let changesDir: string;
  let changeDir: string;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  async function useSchema(name: string): Promise<void> {
    await fs.writeFile(path.join(root, 'openspec', 'config.yaml'), `schema: ${name}\n`);
  }

  /** Copy the shipped org schema into the project, with one key rewritten. */
  async function projectSchemaWith(replacement: [string, string]): Promise<void> {
    const shipped = await fs.readFile(SHIPPED_ORG_SCHEMA, 'utf-8');
    const [from, to] = replacement;
    expect(shipped).toContain(from);
    const dir = path.join(root, 'openspec', 'schemas', 'org-variant');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'schema.yaml'),
      shipped.replace('name: ibalta-org', 'name: org-variant').replace(from, to)
    );
    await useSchema('org-variant');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openspec-org-tasks-'));
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
    changesDir = path.join(root, 'openspec', 'changes');
    changeDir = path.join(changesDir, 'add-export');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'tasks.org'), TASKS_ORG);
    await useSchema('ibalta-org');
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('counts tasks.org through the shipped ibalta-org schema', async () => {
    // A lock on the SHIPPED file, not on a fixture copy of it: reverting
    // `tracks:` in schemas/ibalta-org/schema.yaml reddens this test.
    expect(await getTaskProgressForChange(changesDir, 'add-export', root)).toEqual({ total: 3, completed: 1 });
    expect(resolveTaskFormatForChange(changeDir, root).markup).toBe('org');
  });

  it('goes silently to zero when apply.tracks still names tasks.md', async () => {
    // The other sign, and the reason `tracks` is called out separately from
    // `generates`/`template`: a stale `tracks` is not an error anywhere. The
    // artifact lookup returns undefined, no file is read, and the run reports
    // "no tasks" with a zero exit and an empty stderr - a green run that
    // measured nothing. This test exists so the zero cannot come back quietly.
    await projectSchemaWith(['tracks: tasks.org', 'tracks: tasks.md']);

    expect(await getTaskProgressForChange(changesDir, 'add-export', root)).toEqual({ total: 0, completed: 0 });
  });

  it('goes silently to zero when the tasks artifact still generates tasks.md', async () => {
    await projectSchemaWith(['generates: tasks.org', 'generates: tasks.md']);

    expect(await getTaskProgressForChange(changesDir, 'add-export', root)).toEqual({ total: 0, completed: 0 });
  });
});
