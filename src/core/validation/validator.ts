import { z, ZodError } from 'zod';
import { readFileSync, promises as fs } from 'fs';
import path from 'path';
import { SpecSchema, ChangeSchema, Spec, Change } from '../schemas/index.js';
import { MarkdownParser } from '../parsers/markdown-parser.js';
import { ChangeParser } from '../parsers/change-parser.js';
import { ValidationReport, ValidationIssue, ValidationLevel } from './types.js';
import {
  MIN_PURPOSE_LENGTH,
  MAX_REQUIREMENT_TEXT_LENGTH,
  VALIDATION_MESSAGES,
  buildGuidance,
} from './constants.js';
import {
  parseDeltaSpec,
  foldRequirementName,
  normalizeRequirementName,
  extractRequirementsSection,
  findMissingCurrentScenarios,
  type RequirementBlock,
} from '../parsers/requirement-blocks.js';
import {
  extractRequirementBody as extractRequirementBodyShared,
  countScenarios as countScenariosShared,
} from '../parsers/requirement-text.js';
import { defaultFormat, resolveFormat, type ResolvedFormat } from '../parsers/grammar.js';
import { findMainSpecStructureIssues } from '../parsers/spec-structure.js';
import { buildStructureMask } from '../parsers/code-fence.js';
import { FileSystemUtils } from '../../utils/file-system.js';
import { discoverSpecFiles, hasAnyFileUnder } from '../../utils/spec-discovery.js';
import {
  METADATA_FILENAME,
  readSkipSpecsMarker,
  resolveSchemaForChange,
} from '../../utils/change-metadata.js';
import {
  resolveTaskFilesForChange,
  resolveTaskFormatForChange,
} from '../../utils/task-progress.js';
import { findTaskNumberingIssues } from './task-numbering.js';
import { getPackageSchemasDir, getSchemaDir, resolveSchema } from '../artifact-graph/index.js';
import type { Artifact } from '../artifact-graph/types.js';

/**
 * Whether an artifact's outputs are a project's main specs.
 *
 * The proposal states the relation as "the artifact whose `generates` glob
 * matches the spec file", and that is the question asked here. Nothing in this
 * package can be asked whether a pattern matches a string — `fast-glob` walks a
 * real tree, and a project may hold no spec file yet — so the question is
 * decided on the pattern itself: the glob has to be rooted at the `specs/`
 * directory AND its last segment has to accept the spec file name of the format
 * that same artifact declares. The string-prefix test this replaces answered
 * only the first half, so a leading `./` (a legal glob, and one the artifact
 * graph's own tests use) missed the artifact, while an artifact declaring Org
 * markup behind a `*.md` glob was selected for a file it never generates.
 */
function ownsMainSpecs(artifact: Artifact): boolean {
  const segments = FileSystemUtils.toPosixPath(artifact.generates)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  const fileSegment = segments[segments.length - 1];
  if (segments.length < 2 || segments[0] !== 'specs' || fileSegment === undefined) {
    return false;
  }
  const specFile = resolveFormat(artifact).SPEC_FILE;
  // A wildcard segment accepts every name ending in whatever follows its last
  // `*`, which is what makes `specs/**/*.md` accept `spec.md` and reject
  // `spec.org`. `**` leaves an empty suffix and so accepts either.
  const lastWildcard = fileSegment.lastIndexOf('*');
  return lastWildcard === -1
    ? fileSegment === specFile
    : specFile.endsWith(fileSegment.slice(lastWildcard + 1));
}

/**
 * The format spec content is written in for one project, or for one change
 * within it.
 *
 * The spec artifact is the one whose outputs are the main specs (`ownsMainSpecs`)
 * — read off the schema rather than matched by id, so a schema that names it
 * differently still resolves. A project with no resolvable schema, or a schema
 * with no such artifact, resolves to the built-in defaults, which is today's
 * behavior.
 */
export function resolveSpecArtifactFormat(
  projectRoot: string,
  changeDir?: string
): ResolvedFormat {
  try {
    // Without a change directory there is no change metadata to read; passing
    // `metadata: null` says so, instead of probing the project root for a file
    // that only ever lives inside a change.
    const schemaName = resolveSchemaForChange(
      changeDir ?? projectRoot,
      undefined,
      projectRoot,
      changeDir ? {} : { metadata: null }
    );
    const schema = resolveSchema(schemaName, projectRoot);
    const artifact = schema.artifacts.find(ownsMainSpecs);
    return resolveFormat(artifact);
  } catch {
    return defaultFormat();
  }
}

export class Validator {
  private strictMode: boolean;

  constructor(strictMode: boolean = false) {
    this.strictMode = strictMode;
  }

  async validateSpec(
    filePath: string,
    format: ResolvedFormat = defaultFormat()
  ): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const specName = this.extractNameFromPath(filePath);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parser = new MarkdownParser(content, format);

      const spec = parser.parseSpec(specName);

      const result = SpecSchema.safeParse(spec);

      if (!result.success) {
        issues.push(...this.convertZodErrors(result.error, format));
      }

      issues.push(...this.applySpecRules(spec, content, format));

    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : 'Unknown error';
      const enriched = this.enrichTopLevelError(specName, baseMessage, format);
      issues.push({
        level: 'ERROR',
        path: 'file',
        message: enriched,
      });
    }
    
    return this.createReport(issues);
  }

  /**
   * Validate spec content from a string (used for pre-write validation of rebuilt specs)
   */
  async validateSpecContent(
    specName: string,
    content: string,
    format: ResolvedFormat = defaultFormat()
  ): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    try {
      const parser = new MarkdownParser(content, format);
      const spec = parser.parseSpec(specName);
      const result = SpecSchema.safeParse(spec);
      if (!result.success) {
        issues.push(...this.convertZodErrors(result.error, format));
      }
      issues.push(...this.applySpecRules(spec, content, format));
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : 'Unknown error';
      const enriched = this.enrichTopLevelError(specName, baseMessage, format);
      issues.push({ level: 'ERROR', path: 'file', message: enriched });
    }
    return this.createReport(issues);
  }

  async validateChange(
    filePath: string,
    format: ResolvedFormat = defaultFormat()
  ): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    const changeName = this.extractNameFromPath(filePath);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const changeDir = path.dirname(filePath);
      const parser = new ChangeParser(content, changeDir);

      const change = await parser.parseChangeWithDeltas(changeName);

      const result = ChangeSchema.safeParse(change);

      const marker = readSkipSpecsMarker(changeDir);
      if (marker.invalidReason) {
        issues.push({ level: 'ERROR', path: METADATA_FILENAME, message: this.formatInvalidMarkerMessage(marker.invalidReason) });
      }

      if (!result.success) {
        let zodIssues = this.convertZodErrors(result.error, format);
        // Only the no-deltas error is marker-aware here: the marker+files
        // conflict is validateChangeDeltaSpecs's job, and every caller of
        // this proposal-level pass (archive's non-blocking warnings) pairs
        // it with that gate.
        if (marker.declared) {
          zodIssues = zodIssues.filter(
            issue => !issue.message.startsWith(VALIDATION_MESSAGES.CHANGE_NO_DELTAS)
          );
        }
        issues.push(...zodIssues);
      }
      
      issues.push(...this.applyChangeRules(change, content));

    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : 'Unknown error';
      const enriched = this.enrichTopLevelError(changeName, baseMessage, format);
      issues.push({
        level: 'ERROR',
        path: 'file',
        message: enriched,
      });
    }
    
    return this.createReport(issues);
  }

  /**
   * Validate delta-formatted spec files under a change directory.
   * Enforces:
   * - At least one delta across all files
   * - ADDED/MODIFIED: each requirement has at least one scenario; missing
   *   English SHALL/MUST keywords are guidance unless strict mode is enabled
   * - REMOVED: names only; no scenario/description required
   * - RENAMED: pairs well-formed
   * - No duplicates within sections; no cross-section conflicts per spec
   *
   * When `options.mainSpecsDir` is given, MODIFIED blocks are also checked
   * against the current main specs for the scenario loss archive refuses to
   * apply (#1477). When `options.projectRoot` is given, the schema's tracked
   * task files are checked for ambiguous numbering (#1520). `options.format`
   * is the format the change's spec artifacts are written in; the caller that
   * holds the schema resolves it (`resolveSpecArtifactFormat`). Omitting any of
   * them keeps existing library and archive callers behaving as before.
   */
  async validateChangeDeltaSpecs(
    changeDir: string,
    options: { mainSpecsDir?: string; projectRoot?: string; format?: ResolvedFormat } = {}
  ): Promise<ValidationReport> {
    const format = options.format ?? defaultFormat();
    const issues: ValidationIssue[] = [];
    const specsDir = path.join(changeDir, 'specs');
    let totalDeltas = 0;
    let hasRootLevelSpec = false;
    const missingHeaderSpecs: string[] = [];
    const emptySectionSpecs: Array<{ path: string; sections: string[] }> = [];

    try {
      // Discover delta specs through the same helper the change parser, show,
      // apply, and archive use, so validate never accepts a layout the merge
      // path silently skips (#1385). It finds the resolved spec file at any
      // depth, covering both specs/<capability>/<SPEC_FILE> and the nested
      // multi-area specs/<area>/<capability>/<SPEC_FILE> layout (#1182b). The
      // format has to reach it: discovery without one looks for `spec.md`, so a
      // change whose deltas are named anything else reads as having none.
      const discoveredSpecs = await discoverSpecFiles(specsDir, format);

      // A spec file directly at the specs/ root has no capability folder, so
      // the merge path drops it: without this error the change validates clean
      // and archives while its requirements never reach openspec/specs/ (#1385).
      // Only a regular file counts — a *directory* with that name is a
      // capability folder like any other, and discoverSpecFiles reads it
      // normally.
      const rootSpecStat = await fs.stat(path.join(specsDir, format.SPEC_FILE)).catch(() => null);
      hasRootLevelSpec = rootSpecStat?.isFile() === true;
      if (hasRootLevelSpec) {
        issues.push({
          level: 'ERROR',
          path: format.SPEC_FILE,
          message:
            `Delta spec found at specs/${format.SPEC_FILE}. Delta specs must live under a capability path ` +
            `(e.g. specs/<capability-path>/${format.SPEC_FILE}) — a file at the specs/ root is ignored ` +
            'when the change is applied or archived.',
        });
      }

      for (const { id: specId, specFile } of discoveredSpecs) {
        let content: string | undefined;
        try {
          content = await fs.readFile(specFile, 'utf-8');
        } catch {
          continue;
        }

        const plan = parseDeltaSpec(content, format);
        const entryPath = FileSystemUtils.toPosixPath(path.relative(specsDir, specFile));

        // A delta file's own drawers are checked for structure and id
        // collisions; its requirements are not asked for ids, because the merge
        // is what mints them.
        issues.push(
          ...this.findIdentityIssues(content, format, {
            path: entryPath,
            requireRequirementIds: false,
          })
        );

        // Surface (as INFO, never a failure) the non-canonical level-3 headers
        // the delta reader skipped while parsing ADDED/MODIFIED sections —
        // without this note a stray divider like "### Documentation
        // Requirements" would pass validate <change> while failing
        // archive/validate <spec>. The list comes from the parse itself, so it
        // reflects exactly what the reader skipped.
        const reqMarker = this.requirementMarker(format);
        const reqLabel = this.requirementLabel(format);
        const bareLabel = reqLabel.replace(/:$/, '').toLowerCase();
        for (const stray of plan.skippedHeaders) {
          // A header that is only the label, with or without its colon, names
          // no requirement. Compared as text rather than compiled into a
          // pattern: the label is schema-supplied and may carry regex syntax.
          const header = stray.header.toLowerCase();
          const nameless = header === bareLabel || header === `${bareLabel}:`;
          issues.push({
            level: 'INFO',
            path: entryPath,
            line: stray.line,
            message: nameless
              ? `Header "${reqMarker} ${stray.header}" in ${stray.section} is missing a requirement name and is ignored by validation. Add a name, e.g. "${format.requirementHeaderLine('<name>')}".`
              : `Header "${reqMarker} ${stray.header}" in ${stray.section} is not a "${reqMarker} ${reqLabel}" header and is ignored by validation. Use "${format.requirementHeaderLine(stray.header)}" if it should be validated as a requirement.`,
          });
        }

        const sectionNames: string[] = [];
        if (plan.sectionPresence.added) sectionNames.push(format.deltaSectionLine('ADDED'));
        if (plan.sectionPresence.modified) sectionNames.push(format.deltaSectionLine('MODIFIED'));
        if (plan.sectionPresence.removed) sectionNames.push(format.deltaSectionLine('REMOVED'));
        if (plan.sectionPresence.renamed) sectionNames.push(format.deltaSectionLine('RENAMED'));
        const hasSections = sectionNames.length > 0;
        const hasEntries = plan.added.length + plan.modified.length + plan.removed.length + plan.renamed.length > 0;
        if (!hasEntries) {
          if (hasSections) emptySectionSpecs.push({ path: entryPath, sections: sectionNames });
          else missingHeaderSpecs.push(entryPath);
        }

        const addedNames = new Set<string>();
        const modifiedNames = new Set<string>();
        const removedNames = new Set<string>();
        const renamedFrom = new Set<string>();
        const renamedTo = new Set<string>();

        // Validate ADDED
        for (const block of plan.added) {
          const key = normalizeRequirementName(block.name);
          totalDeltas++;
          if (addedNames.has(key)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Duplicate requirement in ADDED: "${block.name}"` });
          } else {
            addedNames.add(key);
          }
          const requirementText = this.extractRequirementText(block.raw, format);
          if (!requirementText) {
            issues.push({
              level: 'ERROR',
              path: entryPath,
              message: format.containsNormativeKeyword(block.name)
                ? this.buildMissingShallOrMustMessage(`ADDED "${block.name}"`, block.name, format)
                : `ADDED "${block.name}" is missing requirement text`,
            });
          } else if (!format.containsNormativeKeyword(requirementText)) {
            issues.push({
              level: 'WARNING',
              path: entryPath,
              message: this.buildMissingShallOrMustMessage(
                `ADDED "${block.name}"`,
                block.name,
                format,
                true
              ),
            });
          }
          const scenarioCount = this.countScenarios(block.raw, format);
          if (scenarioCount < 1) {
            issues.push({ level: 'ERROR', path: entryPath, message: `ADDED "${block.name}" must include at least one scenario` });
          }
        }

        // Validate MODIFIED
        for (const block of plan.modified) {
          const key = normalizeRequirementName(block.name);
          totalDeltas++;
          if (modifiedNames.has(key)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Duplicate requirement in MODIFIED: "${block.name}"` });
          } else {
            modifiedNames.add(key);
          }
          const requirementText = this.extractRequirementText(block.raw, format);
          if (!requirementText) {
            issues.push({
              level: 'ERROR',
              path: entryPath,
              message: format.containsNormativeKeyword(block.name)
                ? this.buildMissingShallOrMustMessage(`MODIFIED "${block.name}"`, block.name, format)
                : `MODIFIED "${block.name}" is missing requirement text`,
            });
          } else if (!format.containsNormativeKeyword(requirementText)) {
            issues.push({
              level: 'WARNING',
              path: entryPath,
              message: this.buildMissingShallOrMustMessage(
                `MODIFIED "${block.name}"`,
                block.name,
                format,
                true
              ),
            });
          }
          const scenarioCount = this.countScenarios(block.raw, format);
          if (scenarioCount < 1) {
            issues.push({ level: 'ERROR', path: entryPath, message: `MODIFIED "${block.name}" must include at least one scenario` });
          }
        }

        // Run archive's scenario-loss check here too, so the change fails at
        // authoring time instead of days later at archive time (#1477).
        if (options.mainSpecsDir && plan.modified.length > 0) {
          const mainSpecFile = path.join(
            options.mainSpecsDir,
            ...specId.split('/'),
            format.SPEC_FILE
          );
          FileSystemUtils.assertPathWithin(path.dirname(mainSpecFile), mainSpecFile);
          issues.push(
            ...(await this.findScenarioLossIssues(
              plan.modified,
              plan.renamed,
              mainSpecFile,
              entryPath,
              path.dirname(mainSpecFile),
              format
            ))
          );
        }

        // Validate REMOVED (names only)
        for (const name of plan.removed) {
          const key = normalizeRequirementName(name);
          totalDeltas++;
          if (removedNames.has(key)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Duplicate requirement in REMOVED: "${name}"` });
          } else {
            removedNames.add(key);
          }
        }

        // Validate RENAMED pairs
        for (const { from, to } of plan.renamed) {
          const fromKey = normalizeRequirementName(from);
          const toKey = normalizeRequirementName(to);
          totalDeltas++;
          if (renamedFrom.has(fromKey)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Duplicate FROM in RENAMED: "${from}"` });
          } else {
            renamedFrom.add(fromKey);
          }
          if (renamedTo.has(toKey)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Duplicate TO in RENAMED: "${to}"` });
          } else {
            renamedTo.add(toKey);
          }
        }

        // Cross-section conflicts (within the same spec file)
        for (const n of modifiedNames) {
          if (removedNames.has(n)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Requirement present in both MODIFIED and REMOVED: "${n}"` });
          }
          if (addedNames.has(n)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Requirement present in both MODIFIED and ADDED: "${n}"` });
          }
        }
        for (const n of addedNames) {
          if (removedNames.has(n)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `Requirement present in both ADDED and REMOVED: "${n}"` });
          }
        }
        for (const { from, to } of plan.renamed) {
          const fromKey = normalizeRequirementName(from);
          const toKey = normalizeRequirementName(to);
          if (modifiedNames.has(fromKey)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `MODIFIED references old name from RENAMED. Use new header for "${to}"` });
          }
          if (addedNames.has(toKey)) {
            issues.push({ level: 'ERROR', path: entryPath, message: `RENAMED TO collides with ADDED for "${to}"` });
          }
          // Folded comparison: a case/whitespace variant of the FROM header
          // in REMOVED is the same contradiction, not a different name.
          const removedFoldMatch = [...removedNames].find(
            (r) => foldRequirementName(r) === foldRequirementName(fromKey)
          );
          if (removedFoldMatch !== undefined) {
            issues.push({
              level: 'ERROR',
              path: entryPath,
              message:
                `Requirement present in both RENAMED and REMOVED: "${from}"` +
                (removedFoldMatch === fromKey ? '' : ` (REMOVED spells it "${removedFoldMatch}")`),
            });
          }
        }
      }
    } catch (error) {
      // A missing specs dir (or a stray `specs` file) means no deltas;
      // anything else (EACCES, EIO) must stay loud — discoverSpecFiles
      // documents that silently dropping an unreadable capability recreates
      // the data-loss class it prevents, and archive lets the same error
      // propagate.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }

    for (const { path: specPath, sections } of emptySectionSpecs) {
      issues.push({
        level: 'ERROR',
        path: specPath,
        message: `Delta sections ${this.formatSectionList(sections)} were found, but no requirement entries parsed. Ensure each section includes at least one "${this.requirementMarker(format)} ${this.requirementLabel(format)}" block (REMOVED may use bullet list syntax).`,
      });
    }
    for (const path of missingHeaderSpecs) {
      issues.push({
        level: 'ERROR',
        path,
        message: `No delta sections found. Add headers such as "${format.deltaSectionLine('ADDED')}" or move non-delta notes outside specs/.`,
      });
    }

    const marker = readSkipSpecsMarker(changeDir);
    if (marker.invalidReason) {
      issues.push({ level: 'ERROR', path: METADATA_FILENAME, message: this.formatInvalidMarkerMessage(marker.invalidReason) });
    }

    // ANY file under specs/ contradicts the marker - not just parsed deltas.
    // Headerless or stray files would be silently dropped at archive time (and
    // some still satisfy the artifact graph's specs/**  glob) while the change
    // claims to have nothing, so they must surface as an explicit conflict.
    // Probed only when the marker is declared, and unreadable specs/ (a stray
    // `specs` file, permission errors) fails closed as a conflict: the marker
    // claims nothing is there, and validate must not crash where the
    // historical path degraded to "no deltas".
    const skipSpecs = marker.declared;
    let specsDirHasFiles = false;
    if (skipSpecs) {
      try {
        specsDirHasFiles = await hasAnyFileUnder(specsDir);
      } catch {
        specsDirHasFiles = true;
      }
    }
    if (skipSpecs && specsDirHasFiles) {
      issues.push({ level: 'ERROR', path: 'file', message: VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_CONFLICT });
    }

    // The root-level error already names the file and the fix; adding "No
    // deltas found" on top would contradict it, since the deltas are sitting in
    // the file just reported.
    if (totalDeltas === 0 && !hasRootLevelSpec) {
      if (skipSpecs && !specsDirHasFiles) {
        issues.push({ level: 'INFO', path: 'file', message: VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_ACCEPTED });
      } else if (!skipSpecs) {
        issues.push({ level: 'ERROR', path: 'file', message: this.enrichTopLevelError('change', VALIDATION_MESSAGES.CHANGE_NO_DELTAS, format) });
      }
    }

    if (options.projectRoot) {
      issues.push(...await this.collectTaskNumberingIssues(changeDir, options.projectRoot));
    }

    return this.createReport(issues);
  }

  private async collectTaskNumberingIssues(
    changeDir: string,
    projectRoot: string
  ): Promise<ValidationIssue[]> {
    try {
      const schemaName = resolveSchemaForChange(changeDir, undefined, projectRoot).replace(
        /\.ya?ml$/,
        ''
      );
      const schemaDir = getSchemaDir(schemaName, projectRoot);
      const builtInSchemaDir = path.join(getPackageSchemasDir(), 'spec-driven');
      if (
        schemaName !== 'spec-driven' ||
        schemaDir === null ||
        FileSystemUtils.canonicalizeExistingPath(schemaDir) !==
          FileSystemUtils.canonicalizeExistingPath(builtInSchemaDir)
      ) {
        return [];
      }
    } catch {
      return [];
    }

    let taskFiles: string[];
    try {
      taskFiles = resolveTaskFilesForChange(changeDir, projectRoot);
    } catch {
      return [];
    }
    if (taskFiles.length === 0) {
      taskFiles = [path.join(changeDir, 'tasks.md')];
    }

    const documents: Array<{ path: string; content: string }> = [];
    for (const taskFile of taskFiles) {
      let content: string;
      try {
        content = await fs.readFile(taskFile, 'utf-8');
      } catch {
        continue;
      }

      documents.push({
        path: FileSystemUtils.toPosixPath(path.relative(changeDir, taskFile)),
        content,
      });
    }

    documents.sort((left, right) => left.path.localeCompare(right.path));
    // Read with the tracked-tasks artifact's own format, the same one the
    // progress counter uses, so a task line either counts for both or neither.
    const taskFormat = resolveTaskFormatForChange(changeDir, projectRoot);
    return findTaskNumberingIssues(documents, taskFormat).map((issue) => ({
      level: 'WARNING',
      path: issue.path,
      line: issue.line,
      message: issue.message,
    }));
  }

  /**
   * Report MODIFIED requirements whose block omits a scenario the main spec
   * still carries. Uses the same comparison archive applies, so validate can
   * only report what archive would refuse.
   *
   * Silent when the main spec or the requirement header is absent: applying a
   * MODIFIED against a base that is not there yet is a different failure (a
   * sister change still in flight is the legitimate case), and archive is the
   * gate for it. A spec that exists but cannot be read is not absent, though —
   * archive aborts on it, so reporting it beats calling the change valid.
   */
  private async findScenarioLossIssues(
    modified: RequirementBlock[],
    renamed: Array<{ from: string; to: string }>,
    mainSpecFile: string,
    entryPath: string,
    mainSpecRoot: string,
    format: ResolvedFormat
  ): Promise<ValidationIssue[]> {
    let mainContent: string;
    FileSystemUtils.assertPathWithin(mainSpecRoot, mainSpecFile);
    try {
      mainContent = await fs.readFile(mainSpecFile, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Reported only for the codes that mean the file itself is unusable, and
      // will be just as unusable when archive reads it. Everything else -
      // ENOENT/ENOTDIR ("no main spec"), and transient resource errors like
      // EMFILE that say nothing about the file - stays silent rather than
      // failing a change that is fine. `validate --all` reads six changes at
      // once, so a resource error must never become a verdict.
      const UNUSABLE = new Set(['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);
      if (!code || !UNUSABLE.has(code)) return [];
      return [
        {
          level: 'ERROR',
          path: entryPath,
          message:
            `Could not read ${FileSystemUtils.toPosixPath(mainSpecFile)} to check the MODIFIED requirements against it ` +
            `(${code}). Archive reads the same file, so fix the file before archiving.`,
        },
      ];
    }

    const currentBlocks = new Map<string, RequirementBlock>();
    for (const block of extractRequirementsSection(mainContent, format).bodyBlocks) {
      currentBlocks.set(normalizeRequirementName(block.name), block);
    }
    // Archive applies RENAMED before MODIFIED, so a MODIFIED naming the new
    // header is compared against the renamed block's scenarios. Fall back to
    // the old header, or a rename-plus-modify pair would skip the check.
    const renamedFrom = new Map(
      renamed.map(({ from, to }) => [normalizeRequirementName(to), normalizeRequirementName(from)])
    );

    // Walked, not looked up once: renames chain (A→B then B→C leaves C holding
    // A's block), and the visited set stops a cycle from looping forever. Every
    // name in a rename cycle is also a rename FROM, so the skip above already
    // keeps the walk out of one; the guard stays because the cost of being
    // wrong about that is a hung CLI, not a wrong message.
    const currentBlockFor = (name: string): RequirementBlock | undefined => {
      const visited = new Set<string>();
      let key: string | undefined = name;
      while (key !== undefined && !visited.has(key)) {
        const block = currentBlocks.get(key);
        if (block) return block;
        visited.add(key);
        key = renamedFrom.get(key);
      }
      return undefined;
    };

    // A MODIFIED naming a header the same delta renames away is already
    // reported ("MODIFIED references old name from RENAMED"), and the block it
    // would land on is not the one it names — so any scenario named here would
    // send the author after the wrong requirement.
    const renamedAway = new Set(renamed.map(({ from }) => normalizeRequirementName(from)));

    const issues: ValidationIssue[] = [];
    for (const block of modified) {
      const key = normalizeRequirementName(block.name);
      if (renamedAway.has(key)) continue;
      const current = currentBlockFor(key);
      if (!current) continue;
      const missing = findMissingCurrentScenarios(current, block, format);
      if (missing.length === 0) continue;
      issues.push({
        level: 'ERROR',
        path: entryPath,
        message:
          `MODIFIED "${block.name}" omits scenario(s) the current spec still has: ` +
          `${missing.map(name => `"${name}"`).join(', ')}. ` +
          'Copy them into the MODIFIED block (a MODIFIED requirement replaces the whole block, so archive refuses to drop them).',
      });
    }
    return issues;
  }

  private formatInvalidMarkerMessage(invalidReason: string): string {
    return `${VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_INVALID_METADATA} (${invalidReason})`;
  }

  private convertZodErrors(error: ZodError, format: ResolvedFormat): ValidationIssue[] {
    return error.issues.map(err => {
      let message = err.message;
      if (message === VALIDATION_MESSAGES.CHANGE_NO_DELTAS) {
        message = `${message}. ${buildGuidance(format).NO_DELTAS}`;
      }
      return {
        level: 'ERROR' as ValidationLevel,
        path: err.path.join('.'),
        message,
      };
    });
  }

  private applySpecRules(spec: Spec, content: string, format: ResolvedFormat): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const structuralIssue of findMainSpecStructureIssues(content, format)) {
      issues.push({
        level: 'ERROR',
        path: 'file',
        line: structuralIssue.line,
        message: structuralIssue.message,
      });
    }

    issues.push(
      ...this.findIdentityIssues(content, format, { path: 'file', requireRequirementIds: true })
    );

    if (spec.overview.length < MIN_PURPOSE_LENGTH) {
      issues.push({
        level: 'WARNING',
        path: 'overview',
        message: VALIDATION_MESSAGES.PURPOSE_TOO_BRIEF,
      });
    }
    
    spec.requirements.forEach((req, index) => {
      if (req.text.length > MAX_REQUIREMENT_TEXT_LENGTH) {
        issues.push({
          level: 'INFO',
          path: `requirements[${index}]`,
          message: VALIDATION_MESSAGES.REQUIREMENT_TOO_LONG,
        });
      }

      if (req.scenarios.length === 0) {
        issues.push({
          level: 'WARNING',
          path: `requirements[${index}].scenarios`,
          message: `${VALIDATION_MESSAGES.REQUIREMENT_NO_SCENARIOS}. ${buildGuidance(format).SCENARIO_FORMAT}`,
        });
      }
    });

    // SHALL/MUST body-keyword guidance for main specs (#1156, #243). The main-spec
    // parser collapses the requirement header into `text`, so we recover the
    // header+body pairs here (the same source the delta path trusts) and reuse
    // the delta detection. A non-empty body that omits the English keyword gets
    // guidance, while a missing body remains an error. Emitted exactly once per
    // requirement (the Zod refine that used to emit a generic error is removed).
    extractRequirementsSection(content, format).bodyBlocks.forEach((block, index) => {
      const requirementText = this.extractRequirementText(block.raw, format);
      if (!requirementText) {
        issues.push({
          level: 'ERROR',
          path: `requirements[${index}]`,
          message: this.buildMissingShallOrMustMessage(
            `Requirement "${block.name}"`,
            block.name,
            format
          ),
        });
      } else if (!format.containsNormativeKeyword(requirementText)) {
        issues.push({
          level: 'WARNING',
          path: `requirements[${index}]`,
          message: this.buildMissingShallOrMustMessage(
            `Requirement "${block.name}"`,
            block.name,
            format,
            true
          ),
        });
      }
    });

    return issues;
  }

  /**
   * Identity defects a property-drawer format can carry, which no other reader
   * reports.
   *
   * Where a format keeps requirement identity in a drawer under the header
   * (`:PROPERTIES:` / `:ID:` / `:END:`), each failure mode is silent. An
   * unterminated drawer swallows the requirement body up to the next heading,
   * so the requirement validates as bodyless for a reason nothing names. Two
   * blocks carrying one `:ID:` leave every link and every history lookup
   * pointing at either of two requirements. A requirement with no `:ID:` cannot
   * be linked at all. A format with no drawers (`ID_PROPERTY` null — every
   * Markdown project) skips the whole pass, so its behavior is unchanged.
   *
   * Structure is read through the mask every other reader uses
   * (`buildStructureMask`: nothing is masked in Org, because a line of stars is
   * a heading wherever it sits). A pass that hid fenced lines would ask for an
   * `:ID:` on requirements the parsers do read.
   *
   * `requireRequirementIds` is the main-spec half of the rule: a requirement
   * reaches a main spec through an ADDED delta and that merge mints its `:ID:`,
   * so a header without one there was hand-written. It is reported as a
   * WARNING, which is an error only under `--strict`. A change's delta specs
   * are checked for the two structural defects alone — their requirements have
   * no identity yet, by design.
   */
  private findIdentityIssues(
    content: string,
    format: ResolvedFormat,
    options: { path: string; requireRequirementIds: boolean }
  ): ValidationIssue[] {
    const { PROPERTIES_OPEN, DRAWER_END, ID_PROPERTY } = format;
    if (!PROPERTIES_OPEN || !DRAWER_END || !ID_PROPERTY) {
      return [];
    }

    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const structural = buildStructureMask(lines, format);
    const issues: ValidationIssue[] = [];
    const isHeading = (index: number): boolean =>
      !structural[index] && format.HEADING_ANY.test(lines[index]);

    /**
     * The drawer opened at `open`, as the readers see it: it ends at its
     * terminator, or — when there is none — at the next heading, because that
     * is where the drawer stops being able to swallow content.
     */
    const readDrawer = (open: number): { end: number; closed: boolean; ids: string[] } => {
      const ids: string[] = [];
      for (let i = open + 1; i < lines.length; i++) {
        if (DRAWER_END.test(lines[i])) {
          return { end: i, closed: true, ids };
        }
        if (isHeading(i)) {
          return { end: i - 1, closed: false, ids };
        }
        const idMatch = lines[i].match(ID_PROPERTY);
        if (idMatch) {
          ids.push(idMatch[1].trim());
        }
      }
      return { end: lines.length - 1, closed: false, ids };
    };

    // Drawer structure and id uniqueness, over the whole document: a stray
    // drawer is a defect wherever it sits, and ids collide across sections.
    const idLines = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      if (structural[i] || !PROPERTIES_OPEN.test(lines[i])) {
        continue;
      }
      const drawer = readDrawer(i);
      if (!drawer.closed) {
        issues.push({
          level: 'ERROR',
          path: options.path,
          line: i + 1,
          message:
            `Property drawer opened on line ${i + 1} is never closed. ` +
            'Add the drawer terminator after its last property — until then every line down to the next heading is read as drawer content, not as spec text.',
        });
      }
      for (const id of drawer.ids) {
        const previousLine = idLines.get(id);
        if (previousLine !== undefined) {
          issues.push({
            level: 'ERROR',
            path: options.path,
            line: i + 1,
            message:
              `Requirement id "${id}" is declared again in the drawer opened on line ${i + 1}; it was already declared on line ${previousLine}. ` +
              'Ids must be unique within a capability so a link or a history lookup resolves to one requirement.',
          });
        } else {
          idLines.set(id, i + 1);
        }
      }
      i = drawer.end;
    }

    if (!options.requireRequirementIds) {
      return issues;
    }

    // Every requirement in a main spec carries an id. The drawer belonging to a
    // header is the one that opens before any other content follows it, which
    // is where the emitters put it and where Org itself expects it.
    for (let i = 0; i < lines.length; i++) {
      if (structural[i]) continue;
      const requirementMatch = lines[i].match(format.H3_REQUIREMENT);
      if (!requirementMatch) continue;

      let cursor = i + 1;
      while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
      const hasId =
        cursor < lines.length &&
        !structural[cursor] &&
        PROPERTIES_OPEN.test(lines[cursor]) &&
        readDrawer(cursor).ids.length > 0;
      if (!hasId) {
        issues.push({
          level: 'WARNING',
          path: options.path,
          line: i + 1,
          message:
            `Requirement "${requirementMatch[1].trim()}" has no id property. ` +
            'Ids are minted when an ADDED delta is archived, so a requirement without one was written by hand and nothing can link to it.',
        });
      }
    }

    return issues;
  }

  private applyChangeRules(change: Change, content: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    
    const MIN_DELTA_DESCRIPTION_LENGTH = 10;
    
    change.deltas.forEach((delta, index) => {
      if (!delta.description || delta.description.length < MIN_DELTA_DESCRIPTION_LENGTH) {
        issues.push({
          level: 'WARNING',
          path: `deltas[${index}].description`,
          message: VALIDATION_MESSAGES.DELTA_DESCRIPTION_TOO_BRIEF,
        });
      }
      
      if ((delta.operation === 'ADDED' || delta.operation === 'MODIFIED') && 
          (!delta.requirements || delta.requirements.length === 0)) {
        issues.push({
          level: 'WARNING',
          path: `deltas[${index}].requirements`,
          message: `${delta.operation} ${VALIDATION_MESSAGES.DELTA_MISSING_REQUIREMENTS}`,
        });
      }
    });
    
    return issues;
  }

  private enrichTopLevelError(
    itemId: string,
    baseMessage: string,
    format: ResolvedFormat
  ): string {
    const msg = baseMessage.trim();
    const guidance = buildGuidance(format);
    if (msg === VALIDATION_MESSAGES.CHANGE_NO_DELTAS) {
      return `${msg}. ${guidance.NO_DELTAS}`;
    }
    if (msg.includes('Spec must have a Purpose section') || msg.includes('Spec must have a Requirements section')) {
      return `${msg}. ${guidance.MISSING_SPEC_SECTIONS}`;
    }
    if (msg.includes('Change must have a Why section') || msg.includes('Change must have a What Changes section')) {
      return `${msg}. ${guidance.MISSING_CHANGE_SECTIONS}`;
    }
    return msg;
  }

  private extractNameFromPath(filePath: string): string {
    const normalizedPath = FileSystemUtils.toPosixPath(filePath);
    const parts = normalizedPath.split('/');
    
    // Look for the directory name after 'specs' or 'changes'
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === 'specs' || parts[i] === 'changes') {
        if (i < parts.length - 1) {
          return parts[i + 1];
        }
      }
    }
    
    // Fallback to filename without extension if not in expected structure
    const fileName = parts[parts.length - 1] ?? '';
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  }

  private createReport(issues: ValidationIssue[]): ValidationReport {
    const errors = issues.filter(i => i.level === 'ERROR').length;
    const warnings = issues.filter(i => i.level === 'WARNING').length;
    const info = issues.filter(i => i.level === 'INFO').length;
    
    const valid = this.strictMode 
      ? errors === 0 && warnings === 0
      : errors === 0;
    
    return {
      valid,
      issues,
      summary: {
        errors,
        warnings,
        info,
      },
    };
  }

  isValid(report: ValidationReport): boolean {
    return report.valid;
  }

  private extractRequirementText(blockRaw: string, format: ResolvedFormat): string | undefined {
    // Delegate to the shared, fence-/metadata-/multi-line-aware body reader.
    // Validation intentionally does not use the parser/display header-title
    // fallback for canonical requirement blocks: #1280 requires a normative
    // keyword that appears only in the header to receive the body-keyword
    // hint. Line 0 is the requirement header.
    const [, ...bodyLines] = blockRaw.split('\n');
    return extractRequirementBodyShared(bodyLines, format) || undefined;
  }

  /** The heading marker a requirement header is written with (`###` / `**`). */
  private requirementMarker(format: ResolvedFormat): string {
    return format.tokens.requirementHeader.match(format.HEADING_PREFIX)?.[1] ?? '';
  }

  /** The label a requirement header carries before its name (`Requirement:`). */
  private requirementLabel(format: ResolvedFormat): string {
    return format.tokens.requirementHeader
      .replace(format.HEADING_PREFIX, '')
      .split('{name}')[0]
      .trimEnd();
  }

  /**
   * Build a message for a requirement block whose body lacks a normative
   * keyword.
   *
   * When the keyword already appears in the requirement header (e.g.
   * `### Requirement: The system SHALL ...`) the original generic error
   * ("must contain SHALL or MUST") is confusing because the keyword is visibly
   * present in the spec. Per the OpenSpec conventions the keyword has to live
   * on the requirement body line (the line right after the header), so we point
   * the author at that exact fix when the keyword is found in the header only.
   */
  private buildMissingShallOrMustMessage(
    prefix: string,
    blockName: string,
    format: ResolvedFormat,
    guidanceOnly = false
  ): string {
    const keywords = format.NORMATIVE_KEYWORDS.join(' or ');
    const base = `${prefix} ${guidanceOnly ? 'should' : 'must'} contain ${keywords}`;
    const suffix = guidanceOnly ? ' (RFC 2119 best practice for English specs)' : '';
    if (format.containsNormativeKeyword(blockName)) {
      const header = `${this.requirementMarker(format)} ${this.requirementLabel(format)} ...`;
      return `${base} in the requirement body, not only in the header. Move the ${format.NORMATIVE_KEYWORDS.join('/')} statement to the line immediately after the "${header}" header.${suffix}`;
    }
    return `${base}${suffix}`;
  }

  private countScenarios(blockRaw: string, format: ResolvedFormat): number {
    // Fence-aware count via the shared reader: a scenario header inside a fenced
    // Markdown example is not a real scenario. Drop the header line (index 0).
    return countScenariosShared(blockRaw.split('\n').slice(1), format);
  }

  private formatSectionList(sections: string[]): string {
    if (sections.length === 0) return '';
    if (sections.length === 1) return sections[0];
    const head = sections.slice(0, -1);
    const last = sections[sections.length - 1];
    return `${head.join(', ')} and ${last}`;
  }
}
