import { promises as fs } from 'fs';
import path from 'path';
import type { Artifact, SchemaYaml } from '../core/artifact-graph/index.js';
import { resolveArtifactOutputs, resolveSchema } from '../core/artifact-graph/index.js';
import { defaultFormat, resolveFormat, type ResolvedFormat } from '../core/parsers/grammar.js';
import type { ProjectConfig } from '../core/project-config.js';
import { resolveSchemaForChange } from './change-metadata.js';

export interface ParsedTask {
  /** Checkbox state: `[x]`/`[X]` is done, anything else is not. */
  done: boolean;
  /** Task text after the checkbox, trimmed (may be empty). */
  description: string;
}

/**
 * Parses every task line in a tasks file, in document order.
 *
 * A task line is a bullet carrying a checkbox; which bullet characters and
 * which in-box marks count is the format's business (`format.TASK_LINE`). The
 * Markdown default is the pattern this function carried before the format
 * parameter existed, so an unresolved caller counts exactly what it counted
 * before. Org additionally accepts `[-]`, its own "started, not done" mark,
 * which is a task and therefore belongs in the denominator.
 *
 * The recognizer stays permissive on purpose: any character class tightened
 * here drops lines that used to count, and a task this parser drops is a task
 * `openspec archive` stops warning about.
 *
 * Every line matching the pattern counts, wherever it sits - inside a code
 * fence, an HTML comment or an indented block, as before. Skipping fenced
 * checkboxes was tried and dropped: every rule for deciding which fence is
 * "real" has an input where a stray or unbalanced fence swallows genuine tasks.
 * Counting a documented example as work is a loud, bypassable false positive;
 * losing a real task is a silent one.
 */
export function parseTaskLines(
  content: string,
  format: ResolvedFormat = defaultFormat()
): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  for (const line of content.split('\n')) {
    const match = line.match(format.TASK_LINE);
    if (match) {
      tasks.push({ done: match[1].toLowerCase() === 'x', description: match[2].trim() });
    }
  }

  return tasks;
}

export interface TaskProgress {
  total: number;
  completed: number;
}

export function countTasksFromContent(
  content: string,
  format: ResolvedFormat = defaultFormat()
): TaskProgress {
  const tasks = parseTaskLines(content, format);
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.done).length,
  };
}

/**
 * Identifies the change's tracked-tasks artifact: the artifact whose `generates`
 * equals the schema's `apply.tracks` value, falling back to the artifact with id
 * `tasks` when no `apply` block declares what it tracks. (`apply.tracks` is a
 * filename that *selects* the artifact; the glob is that artifact's `generates`.)
 */
function findTrackedTasksArtifact(schema: SchemaYaml): Artifact | undefined {
  const tracks = schema.apply?.tracks;
  if (tracks != null) {
    return schema.artifacts.find((a) => a.generates === tracks);
  }
  return schema.artifacts.find((a) => a.id === 'tasks');
}

/** What one schema contributes to counting a change's tasks. */
interface TrackedTasks {
  /** The tracked-tasks artifact's output glob, when there is one. */
  generates: string | undefined;
  /** The format that artifact's content is written in. */
  format: ResolvedFormat;
}

/**
 * Run-scoped memo mapping a schema name to its tracked-tasks `generates` glob.
 * When one command resolves progress for many changes under a constant
 * `projectRoot` — e.g. `validate --archived` over an append-only archive — this
 * avoids re-reading and re-parsing (YAML + Zod) the same `schema.yaml` once per
 * change. Keyed by schema name alone, which is safe *only* because a single run
 * holds `projectRoot` constant; never reuse one cache across differing roots.
 */
export type SchemaGlobCache = Map<string, string | undefined>;

/**
 * The formats that accompany a caller's glob cache, keyed by the cache object
 * itself.
 *
 * A side table rather than a richer cache value: the glob cache's value type is
 * part of what callers observe, and both halves must be memoized together or
 * the schema would be re-parsed per change to recover the half that was not.
 * Keying on the cache makes the memo exactly as long-lived as the run that owns
 * it.
 */
const formatsByGlobCache = new WeakMap<SchemaGlobCache, Map<string, ResolvedFormat>>();

const NO_TRACKED_TASKS: TrackedTasks = { generates: undefined, format: defaultFormat() };

/**
 * What a caller that has already resolved the change's schema — or already read
 * the project config — hands the resolver so neither is read a second time.
 *
 * Not an optimization: `readProjectConfig` reports a malformed `operations:`
 * block on every read, and the CLI's contract is one warning per command. A
 * command that resolved the schema once and then let this resolver resolve it
 * again printed that warning twice
 * (`artifact-workflow.test.ts` "emits one warning per command"). Upstream keeps
 * no config cache on purpose (`project-config.ts`: "changes are reflected
 * immediately without stale cache issues"), so the already-read value has to
 * travel by parameter.
 */
export interface TrackedTasksOptions {
  /**
   * The schema name the caller already resolved for this change. Supplying it
   * skips schema-name resolution entirely, so the tasks format is the format of
   * the very schema the rest of the command is using — including when the CLI
   * overrode it with `--schema`.
   */
  schemaName?: string;
  /**
   * Pre-read project config, forwarded to `resolveSchemaForChange`, which
   * suppresses its fallback config read only when this is not `undefined`.
   * Passing `undefined` therefore preserves the previous read-it-myself
   * behavior exactly.
   */
  projectConfig?: ProjectConfig | null;
}

/**
 * Resolves the tracked-tasks artifact's output glob and format for a change.
 * `resolveSchema` throws on an unresolvable/misnamed schema; we swallow that so
 * the caller falls back to a single top-level `tasks.md`, counted with the
 * default format, and never crashes. A `schemaGlobCache`, when supplied,
 * memoizes the schema-name lookup for the duration of one run.
 */
function resolveTrackedTasks(
  changeDir: string,
  projectRoot: string,
  schemaGlobCache?: SchemaGlobCache,
  options: TrackedTasksOptions = {}
): TrackedTasks {
  try {
    const schemaName =
      options.schemaName ??
      resolveSchemaForChange(changeDir, undefined, projectRoot, {
        projectConfig: options.projectConfig,
      });
    let formats: Map<string, ResolvedFormat> | undefined;
    if (schemaGlobCache) {
      formats = formatsByGlobCache.get(schemaGlobCache);
      if (!formats) {
        formats = new Map();
        formatsByGlobCache.set(schemaGlobCache, formats);
      }
      const format = formats.get(schemaName);
      if (format && schemaGlobCache.has(schemaName)) {
        return { generates: schemaGlobCache.get(schemaName), format };
      }
    }
    const schema = resolveSchema(schemaName, projectRoot);
    const artifact = findTrackedTasksArtifact(schema);
    const tracked: TrackedTasks = {
      generates: artifact?.generates,
      format: resolveFormat(artifact),
    };
    schemaGlobCache?.set(schemaName, tracked.generates);
    formats?.set(schemaName, tracked.format);
    return tracked;
  } catch {
    return NO_TRACKED_TASKS;
  }
}

/** Resolves the task files selected by the schema's apply tracking rule. */
export function resolveTaskFilesForChange(
  changeDir: string,
  projectRoot: string,
  schemaGlobCache?: SchemaGlobCache
): string[] {
  const { generates } = resolveTrackedTasks(changeDir, projectRoot, schemaGlobCache);
  return generates ? resolveArtifactOutputs(changeDir, generates) : [];
}

/**
 * The format a change's task files are written in — the tracked-tasks
 * artifact's, defaulting to Markdown when the schema declares none. Exposed so
 * a caller that reads those files itself (task-numbering via `validate`) reads
 * them the same way the counter does.
 */
export function resolveTaskFormatForChange(
  changeDir: string,
  projectRoot: string,
  schemaGlobCache?: SchemaGlobCache,
  options?: TrackedTasksOptions
): ResolvedFormat {
  return resolveTrackedTasks(changeDir, projectRoot, schemaGlobCache, options).format;
}

export interface TaskProgressDetail extends TaskProgress {
  /**
   * Task files that exist but could not be read (any error other than ENOENT).
   * `getTaskProgressForChange` discards this list to preserve its behavior;
   * callers that must fail loudly on an unreadable tasks file — e.g.
   * `openspec validate --archived` — read it so an unreadable file is never
   * silently counted as "no tasks" (#205).
   */
  unreadable: string[];
}

/**
 * Reads one task file and counts its checkboxes. ENOENT (a glob file that
 * vanished between resolve and read, or the absent single top-level `tasks.md`)
 * means zero tasks, exactly as before. Any other error (permissions, I/O,
 * ENOTDIR) is recorded in `unreadable` so a caller can surface it; the count
 * still contributes zero, so existing callers see no change.
 */
async function countTaskFile(
  file: string,
  unreadable: string[],
  format: ResolvedFormat
): Promise<TaskProgress> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return countTasksFromContent(content, format);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') unreadable.push(file);
    return { total: 0, completed: 0 };
  }
}

/**
 * Computes a change's task progress by resolving its tracked-tasks artifact and
 * counting checkboxes across every file matched by that artifact's `generates`
 * glob — the same file-resolution `openspec status` uses to detect the tasks
 * artifact (`resolveArtifactOutputs`) — so progress is no longer blind to nested
 * `tasks.md` files (#1202). Falls back to a single top-level `tasks.md` (exactly
 * as before) when the schema is unresolvable, no tracked-tasks artifact is found,
 * or the glob matches no file. Also reports task files that exist but could not
 * be read. Per-file read errors are captured (never thrown); the only throw path
 * is a malformed/unsafe schema whose glob resolution rejects (path traversal or
 * a linked-directory cycle in `resolveArtifactOutputs`). Pass `schemaGlobCache`
 * to memoize schema→glob resolution across many changes in one run.
 */
export async function getTaskProgressDetailForChange(
  changesDir: string,
  changeName: string,
  projectRoot: string,
  schemaGlobCache?: SchemaGlobCache
): Promise<TaskProgressDetail> {
  const changeDir = path.join(changesDir, changeName);
  const { generates, format } = resolveTrackedTasks(changeDir, projectRoot, schemaGlobCache);
  const files = generates ? resolveArtifactOutputs(changeDir, generates) : [];
  // `tasks.md` stays the literal fallback: `generates` is required on every
  // artifact, so an absent glob means no tracked-tasks artifact resolved at all,
  // and `format` is the Markdown default in exactly that case.
  const targets = files.length > 0 ? files : [path.join(changeDir, 'tasks.md')];
  const unreadable: string[] = [];
  let total = 0;
  let completed = 0;
  for (const file of targets) {
    const progress = await countTaskFile(file, unreadable, format);
    total += progress.total;
    completed += progress.completed;
  }
  return { total, completed, unreadable };
}

/**
 * The task-completion counter `status`, `list`, and `archive` share. Delegates
 * to `getTaskProgressDetailForChange` and drops the `unreadable` detail, so its
 * returned totals are unchanged. Throws only on the same malformed/unsafe-schema
 * glob-resolution path as that function (existing behavior; callers guard it as
 * they did before).
 */
export async function getTaskProgressForChange(
  changesDir: string,
  changeName: string,
  projectRoot: string
): Promise<TaskProgress> {
  const { total, completed } = await getTaskProgressDetailForChange(
    changesDir,
    changeName,
    projectRoot
  );
  return { total, completed };
}

export function formatTaskStatus(progress: TaskProgress): string {
  if (progress.total === 0) return 'No tasks';
  if (progress.completed === progress.total) return '✓ Complete';
  return `${progress.completed}/${progress.total} tasks`;
}


