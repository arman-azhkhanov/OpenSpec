import { promises as fs } from 'fs';
import path from 'path';
import { JsonConverter } from '../core/converters/json-converter.js';
import { Validator, resolveSpecArtifactFormat } from '../core/validation/validator.js';
import { VALIDATION_MESSAGES } from '../core/validation/constants.js';
import { ChangeParser } from '../core/parsers/change-parser.js';
import {
  deltaHeaders,
  resolveFormat,
  scenarioLabel,
  type ResolvedFormat,
} from '../core/parsers/grammar.js';
import { Change } from '../core/schemas/index.js';
import type { Artifact } from '../core/artifact-graph/index.js';
import { resolveSchema } from '../core/artifact-graph/index.js';
import type { RootOutput } from '../core/root-selection.js';
import { isInteractive } from '../utils/interactive.js';
import { getActiveChangeIds } from '../utils/item-discovery.js';
import { getTaskProgressForChange } from '../utils/task-progress.js';
import { resolveSchemaForChange } from '../utils/change-metadata.js';
import { FileSystemUtils } from '../utils/file-system.js';

/**
 * True only when `target` is definitively absent. An EACCES or I/O failure
 * means existence cannot be determined, so callers fall through to their
 * read-error path rather than claim the file was never written.
 */
async function isDefinitelyMissing(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => false)
    .catch((error: NodeJS.ErrnoException) => error?.code === 'ENOENT');
}

/**
 * A change is a directory directly under changes/. Rejecting anything else up
 * front keeps a traversing name (`../..`) from reading a proposal outside the
 * changes directory, and keeps the missing-proposal message honest.
 */
function isChangeDirectoryName(changesPath: string, changeDir: string): boolean {
  return path.dirname(path.resolve(changeDir)) === path.resolve(changesPath);
}

export class ChangeCommand {
  private converter: JsonConverter;
  private rootPath?: string;

  // rootPath is set only by root-aware callers (top-level `show`); the
  // deprecated noun-form commands stay cwd-based.
  constructor(rootPath?: string) {
    this.converter = new JsonConverter();
    this.rootPath = rootPath;
  }

  private getChangesPath(): string {
    return path.join(this.rootPath ?? process.cwd(), 'openspec', 'changes');
  }

  /**
   * Resolves the change's `proposal` artifact from its schema — the same
   * shape `findTrackedTasksArtifact` (utils/task-progress.ts) uses for the
   * tracked-tasks artifact — or `undefined` when the schema cannot be
   * resolved or declares no artifact with `id: proposal`. `resolveSchema`
   * throws on an unresolvable/misnamed schema; that is swallowed here so a
   * change whose schema cannot be read falls back to the pre-schema
   * behavior instead of crashing `show`/`list`.
   *
   * MUST NOT be called before a `changeDir` is confirmed inside its
   * `changes/` directory: a traversing `changeName` (`../..`) must be
   * rejected on the path alone, with zero reads outside the sandbox — the
   * same invariant `isChangeDirectoryName` exists to enforce.
   */
  private resolveProposalArtifact(changeDir: string, projectRoot: string): Artifact | undefined {
    try {
      const schemaName = resolveSchemaForChange(changeDir, undefined, projectRoot);
      const schema = resolveSchema(schemaName, projectRoot);
      return schema.artifacts.find((a) => a.id === 'proposal');
    } catch {
      return undefined;
    }
  }

  /**
   * The proposal artifact's declared filename, or the classic `proposal.md`
   * when the schema declares no `proposal` artifact — so a schema without
   * one behaves exactly as it did before this patch.
   */
  private proposalFilename(artifact: Artifact | undefined): string {
    return artifact?.generates ?? 'proposal.md';
  }

  /**
   * Show a change proposal.
   * - Text mode: raw markdown passthrough (no filters)
   * - JSON mode: minimal object with deltas; --deltas-only returns same object with filtered deltas
   *   Note: --requirements-only is deprecated alias for --deltas-only
   */
  async show(changeName?: string, options?: { json?: boolean; requirementsOnly?: boolean; deltasOnly?: boolean; noInteractive?: boolean; rootOutput?: RootOutput }): Promise<void> {
    const changesPath = this.getChangesPath();

    if (!changeName) {
      const canPrompt = isInteractive(options);
      // Offer exactly the changes `show <name>` can resolve.
      const changes = await getActiveChangeIds(this.rootPath ?? process.cwd());
      if (canPrompt && changes.length > 0) {
        const { select } = await import('@inquirer/prompts');
        const selected = await select({
          message: 'Select a change to show',
          choices: changes.map(id => ({ name: id, value: id })),
        });
        changeName = selected;
      } else {
        if (changes.length === 0) {
          console.error('No change specified. No active changes found.');
        } else {
          console.error(`No change specified. Available IDs: ${changes.join(', ')}`);
        }
        console.error('Hint: use "openspec change list" to view available changes.');
        process.exitCode = 1;
        return;
      }
    }

    const changeDir = path.join(changesPath, changeName);
    // Literal on purpose: containment is not confirmed yet, so nothing about
    // this change — not even its schema — may be read to build this message.
    const literalProposalPath = path.join(changeDir, 'proposal.md');

    if (!isChangeDirectoryName(changesPath, changeDir)) {
      throw new Error(`Change "${changeName}" not found at ${literalProposalPath}`);
    }

    const projectRoot = this.rootPath ?? process.cwd();
    const proposalArtifact = this.resolveProposalArtifact(changeDir, projectRoot);
    const proposalPath = path.join(changeDir, this.proposalFilename(proposalArtifact));

    try {
      await fs.access(proposalPath);
    } catch {
      // A change can exist without a proposal: `openspec new change` scaffolds
      // only .openspec.yaml, and a custom schema need not define a proposal
      // artifact. Say which of the two cases this is instead of reporting a
      // change that does exist as missing. A stray file under changes/ is not a
      // change, and naming it one would point the user at a `status --change`
      // call that cannot work.
      const isChangeDirectory = await fs
        .stat(changeDir)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (isChangeDirectory) {
        throw new Error(
          `Change "${changeName}" has no proposal.md yet. ` +
            `Run "openspec status --change ${changeName}" to see which artifact comes next.`
        );
      }
      throw new Error(`Change "${changeName}" not found at ${proposalPath}`);
    }
    FileSystemUtils.assertPathWithin(path.dirname(proposalPath), proposalPath);

    if (options?.json) {
      FileSystemUtils.assertPathWithin(changeDir, proposalPath);
      const jsonOutput = await this.converter.convertChangeToJson(
        proposalPath,
        resolveFormat(proposalArtifact)
      );

      if (options.requirementsOnly) {
        console.error('Flag --requirements-only is deprecated; use --deltas-only instead.');
      }

      const parsed: Change = JSON.parse(jsonOutput);
      FileSystemUtils.assertPathWithin(changeDir, proposalPath);
      const contentForTitle = await fs.readFile(proposalPath, 'utf-8');
      const title = this.extractTitle(contentForTitle, changeName, resolveFormat(proposalArtifact));
      const id = parsed.name;
      const deltas = parsed.deltas || [];

      const output = {
        id,
        title,
        deltaCount: deltas.length,
        deltas,
        ...(options.rootOutput ? { root: options.rootOutput } : {}),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      FileSystemUtils.assertPathWithin(changeDir, proposalPath);
      const content = await fs.readFile(proposalPath, 'utf-8');
      console.log(content);
    }
  }

  /**
   * List active changes.
   * - Text default: IDs only; --long prints minimal details (title, counts)
   * - JSON: array of { id, title, deltaCount, taskStatus }, sorted by id
   */
  async list(options?: { json?: boolean; long?: boolean }): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    // Matches changesPath above: this deprecated noun-form command stays
    // cwd-based (unlike `show`, which honors a root-aware caller's rootPath).
    const projectRoot = process.cwd();

    // Same directory-based resolution as `openspec list`, the command this
    // deprecated alias points users at. Every output path below already
    // tolerates a change whose proposal.md is missing or unreadable.
    const changes = await getActiveChangeIds();

    if (options?.json) {
      const changeDetails = await Promise.all(
        changes.map(async (changeName) => {
          const changeDir = path.join(changesPath, changeName);
          // Safe to resolve immediately: changeName came from a real
          // directory entry (getActiveChangeIds → fs.readdir), never from
          // untrusted input, so there is no containment check to precede.
          const proposalArtifact = this.resolveProposalArtifact(changeDir, projectRoot);
          const proposalPath = path.join(changeDir, this.proposalFilename(proposalArtifact));

          // Resolve task progress through the shared tracked-tasks helper so
          // this deprecated noun-form list cannot re-fork the resolution
          // (#1202). Tasks are independent of the proposal: a change can carry
          // tasks before, or without, a proposal.md.
          const taskStatus = await getTaskProgressForChange(changesPath, changeName, process.cwd());

          // No proposal yet is an ordinary state (scaffolded change, or a
          // schema with no proposal artifact), so name the change rather than
          // labelling it Unknown. Unknown stays for a proposal that exists but
          // cannot be read or parsed.
          if (await isDefinitelyMissing(proposalPath)) {
            return { id: changeName, title: changeName, deltaCount: 0, taskStatus };
          }

          try {
            FileSystemUtils.assertPathWithin(changeDir, proposalPath);
            const content = await fs.readFile(proposalPath, 'utf-8');
            const parser = new ChangeParser(content, changeDir, resolveFormat(proposalArtifact));
            const change = await parser.parseChangeWithDeltas(changeName);

            return {
              id: changeName,
              title: this.extractTitle(content, changeName, resolveFormat(proposalArtifact)),
              deltaCount: change.deltas.length,
              taskStatus,
            };
          } catch {
            return { id: changeName, title: 'Unknown', deltaCount: 0, taskStatus };
          }
        })
      );
      
      const sorted = changeDetails.sort((a, b) => a.id.localeCompare(b.id));
      console.log(JSON.stringify(sorted, null, 2));
    } else {
      if (changes.length === 0) {
        console.log('No items found');
        return;
      }
      const sorted = [...changes].sort();
      if (!options?.long) {
        // IDs only
        sorted.forEach(id => console.log(id));
        return;
      }

      // Long format: id: title and minimal counts
      for (const changeName of sorted) {
        const changeDir = path.join(changesPath, changeName);
        // Safe to resolve immediately — see the JSON branch above.
        const proposalArtifact = this.resolveProposalArtifact(changeDir, projectRoot);
        const proposalPath = path.join(changeDir, this.proposalFilename(proposalArtifact));
        const { total, completed } = await getTaskProgressForChange(changesPath, changeName, process.cwd());
        const taskStatusText = total > 0 ? ` [tasks ${completed}/${total}]` : '';
        if (await isDefinitelyMissing(proposalPath)) {
          console.log(`${changeName}: (no proposal.md yet)${taskStatusText}`);
          continue;
        }
        try {
          FileSystemUtils.assertPathWithin(changeDir, proposalPath);
          const content = await fs.readFile(proposalPath, 'utf-8');
          const title = this.extractTitle(content, changeName, resolveFormat(proposalArtifact));
          const parser = new ChangeParser(content, changeDir, resolveFormat(proposalArtifact));
          const change = await parser.parseChangeWithDeltas(changeName);
          const deltaCountText = ` [deltas ${change.deltas.length}]`;
          console.log(`${changeName}: ${title}${deltaCountText}${taskStatusText}`);
        } catch {
          console.log(`${changeName}: (unable to read)${taskStatusText}`);
        }
      }
    }
  }

  async validate(changeName?: string, options?: { strict?: boolean; json?: boolean; noInteractive?: boolean }): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    
    if (!changeName) {
      const canPrompt = isInteractive(options);
      const changes = await getActiveChangeIds();
      if (canPrompt && changes.length > 0) {
        const { select } = await import('@inquirer/prompts');
        const selected = await select({
          message: 'Select a change to validate',
          choices: changes.map(id => ({ name: id, value: id })),
        });
        changeName = selected;
      } else {
        if (changes.length === 0) {
          console.error('No change specified. No active changes found.');
        } else {
          console.error(`No change specified. Available IDs: ${changes.join(', ')}`);
        }
        console.error('Hint: use "openspec change list" to view available changes.');
        process.exitCode = 1;
        return;
      }
    }
    
    const changeDir = path.join(changesPath, changeName);
    if (!isChangeDirectoryName(changesPath, changeDir)) {
      throw new Error(`Change "${changeName}" not found at ${changeDir}`);
    }
    try {
      await fs.access(changeDir);
    } catch {
      throw new Error(`Change "${changeName}" not found at ${changeDir}`);
    }
    
    const validator = new Validator(options?.strict || false);
    const projectRoot = path.dirname(path.dirname(changesPath));
    const changeFormat = resolveSpecArtifactFormat(projectRoot, changeDir);
    const report = await validator.validateChangeDeltaSpecs(changeDir, {
      // Derived from changesPath so the main specs come from the same root the
      // change itself was resolved against.
      mainSpecsDir: path.join(path.dirname(changesPath), 'specs'),
      projectRoot,
      format: changeFormat,
    });
    
    if (options?.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.valid) {
        console.log(`Change "${changeName}" is valid`);
      } else {
        console.error(`Change "${changeName}" has issues`);
        report.issues.forEach(issue => {
          const label = issue.level === 'ERROR' ? 'ERROR' : 'WARNING';
          const prefix = issue.level === 'ERROR' ? '✗' : '⚠';
          console.error(`${prefix} [${label}] ${issue.path}: ${issue.message}`);
        });
        // Next steps footer to guide fixing issues, named in the change's own
        // markup — the same format `validateChangeDeltaSpecs` just read it in.
        this.printNextSteps(report.issues, changeFormat);
        if (!options?.json) {
          process.exitCode = 1;
        }
      }
    }
  }

  /**
   * `format` defaults to the built-in Markdown resolution so a call site
   * with no schema in hand (there is none left in this file, but the
   * default keeps the signature safe for a future one) keeps today's
   * behavior — same convention `resolveFormat` itself documents.
   *
   * FORK-ONLY branch: Org has no `# ` heading (a bare `#` line is an Org
   * comment, not structure — deliberately NOT matched here, so a proposal
   * that only carries comment lines falls through to `changeName` exactly
   * like a Markdown proposal with no `#` line does); its title lives in the
   * `#+TITLE:` keyword line instead.
   */
  private extractTitle(
    content: string,
    changeName: string,
    format: ResolvedFormat = resolveFormat()
  ): string {
    if (format.markup === 'org') {
      const match = content.match(/^#\+TITLE:\s*(.+)$/im);
      return match ? match[1].trim() : changeName;
    }
    const match = content.match(/^#\s+(?:Change:\s+)?(.+)$/im);
    return match ? match[1].trim() : changeName;
  }

  private printNextSteps(
    issues: Array<{ message: string }> = [],
    format: ResolvedFormat = resolveFormat()
  ): void {
    const bullets: string[] = [];
    // Branch on the exact marker messages: the generic no-deltas guidance
    // also mentions skip_specs and must not trigger the marker bullets.
    const conflictIssue = issues.some(i =>
      i.message.includes(VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_CONFLICT)
    );
    const invalidMarkerIssue = issues.some(i =>
      i.message.includes(VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_INVALID_METADATA)
    );
    if (conflictIssue) {
      bullets.push('- This change declares skip_specs (no spec deltas): delete the files under specs/, or remove skip_specs from .openspec.yaml if requirements do change');
      bullets.push('- skip_specs is only honored when .openspec.yaml is valid change metadata (schema: <name> is required)');
    } else if (invalidMarkerIssue) {
      bullets.push('- Fix .openspec.yaml so the skip_specs marker can be honored (schema: <name> is required)');
      bullets.push('- Or remove skip_specs from .openspec.yaml and add delta specs instead');
    } else {
      // Rendered from the format's own header tokens through the SAME two
      // helpers `openspec validate` uses, not from Markdown literals: this
      // footer is the instruction an author follows to fix the very file that
      // failed validation, so quoting hash-prefixed delta and scenario headers
      // at an Org project names headers its parser cannot see. Markdown output
      // is byte-identical to the literals this replaces.
      bullets.push(`- Ensure change has deltas in specs/: use headers ${deltaHeaders(format)}`);
      bullets.push(`- Each requirement MUST include at least one ${scenarioLabel(format)} block`);
      bullets.push('- Debug parsed deltas: openspec change show <id> --json --deltas-only');
    }
    console.error('Next steps:');
    bullets.forEach(b => console.error(`  ${b}`));
  }
}
