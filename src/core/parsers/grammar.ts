/**
 * The one place that knows what a spec's structural tokens look like.
 *
 * Recognition anchors used to be module-level literals spread across the
 * parsers, the validator and the emitters, so a schema could not say that its
 * artifacts are written any other way. `resolveFormat` turns those literals
 * into a value resolved PER ARTIFACT: an artifact that declares no `format`
 * block resolves to the built-in Markdown defaults, and those defaults are the
 * very regexes the parsers carried before this module existed, so a project
 * that declares nothing behaves exactly as it did.
 *
 * Resolution is a pure function of the artifact definition. There is no
 * module-level mutable format and no process-wide setter, which is what lets
 * two artifacts of one schema declare different formats without either
 * overriding the other.
 *
 * Layering, because it decides what may be contributed upstream:
 *   - the five declarable token shapes (`requirementsSection`,
 *     `requirementHeader`, `scenarioHeader`, `deltaSection`,
 *     `normativeKeywords`) and this resolution mechanism are format-agnostic;
 *   - `markup` and everything it selects (heading marker, fence syntax, bullet
 *     class, checkbox class, property drawers) is FORK-ONLY. It is marked so at
 *     every site.
 */

import type { Artifact } from '../artifact-graph/types.js';
import { isKebabId } from '../id.js';

/**
 * FORK-ONLY. The markup family an artifact's content is written in. It selects
 * the shapes that no token template can express: how a heading is marked, how a
 * block is fenced, which bullet and checkbox characters count, whether identity
 * lives in a property drawer.
 */
export type MarkupFamily = 'markdown' | 'org';

export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

export const DELTA_OPERATIONS: readonly DeltaOperation[] = [
  'ADDED',
  'MODIFIED',
  'REMOVED',
  'RENAMED',
];

/** The token shapes a resolved format reads and writes with. */
export interface FormatTokens {
  /** Declarable. The section that holds a main spec's requirements. */
  requirementsSection: string;
  /** Declarable. `{name}` marks the requirement title. */
  requirementHeader: string;
  /** Declarable. `{name}` marks the scenario title. */
  scenarioHeader: string;
  /** Declarable. `{operation}` marks ADDED / MODIFIED / REMOVED / RENAMED. */
  deltaSection: string;
  /** Declarable. Literal keywords, compiled with word boundaries. */
  normativeKeywords: readonly string[];
  /** Family-level, not declarable: the Purpose section of a main spec. */
  purposeSection: string;
  /** Family-level, not declarable: `{name}` marks the capability. */
  specTitle: string;
}

/**
 * Everything a reader, a validator or an emitter needs in order to work on one
 * artifact's content. Regex fields keep the SCREAMING_SNAKE names the parsers
 * used for the same literals, so a call site reads as `format.X` where it used
 * to read `X`.
 *
 * Regexes are stateless (no `g` flag) and safe to share.
 */
export interface ResolvedFormat {
  /** FORK-ONLY discriminator for the branches no token can express. */
  markup: MarkupFamily;
  /** File name a capability's main spec is stored under. */
  SPEC_FILE: string;
  tokens: FormatTokens;

  /** Any heading: group 1 = the marker run, group 2 = the title. */
  HEADING_ANY: RegExp;
  /** Any heading, marker only. */
  HEADING_PREFIX: RegExp;
  /**
   * Markdown-numbered depth of a heading line, or null when the line is not a
   * heading. Org counts one star fewer than Markdown counts hashes at the same
   * depth (the file title is `#+TITLE:`, not a heading), so the number returned
   * is the Markdown depth in both families and the document model is unchanged.
   */
  headingLevel(line: string): number | null;

  /** Top-level section boundary (Markdown `##`). */
  H2_ANY: RegExp;
  /** Top-level section with its title captured. */
  H2_TITLED: RegExp;
  H2_REQUIREMENTS: RegExp;
  H2_PURPOSE: RegExp;
  /** Delta section, anchored: group 1 = the operation. */
  H2_DELTA: RegExp;
  /** Delta section, unanchored + multiline, for whole-document scans. */
  H2_DELTA_LOOSE: RegExp;
  /** Requirement header, group 1 = the name. */
  H3_REQUIREMENT: RegExp;
  /** Requirement header tolerating a missing space after the marker. */
  H3_REQUIREMENT_LOOSE: RegExp;
  /** Any requirement-depth heading, group 1 = the title. */
  H3_ANY_TITLED: RegExp;
  /**
   * A parsed section title — the heading line with its marker already stripped
   * — that names a requirement. Readers that walk a parsed section tree have no
   * heading marker left to match `H3_REQUIREMENT` against; this is the same
   * judgement at that level, derived from the same token.
   */
  REQUIREMENT_TITLE: RegExp;
  /** Any scenario-depth heading. Deliberately not `Scenario:`-only: the spec
   *  path treats every child of a requirement at this depth as a scenario. */
  H4_SCENARIO: RegExp;
  /** Scenario-depth heading that does say `Scenario:`. */
  H4_SCENARIO_TITLED: RegExp;
  /** Task-file group heading (task numbering). */
  LEVEL_TWO_HEADING: RegExp;
  /** Numbered task-file group heading, group 1 = the group number. */
  NUMBERED_GROUP_HEADING: RegExp;

  /** Fence opener. Group 1 = the fence identity a closer must match. */
  FENCE_OPEN: RegExp;
  /** Fence closer. Group 1 = the fence identity. */
  FENCE_CLOSE: RegExp;
  /**
   * FORK-ONLY. Whether a fenced block hides headings from the readers.
   * Markdown: yes. Org: no — a line starting with `*` is a heading even inside
   * `#+begin_src`, so an illustration heading is kept out of the parse by Org's
   * own comma escape (`,** Requirement:`), written by the author of the block.
   * Nothing here escapes on the author's behalf: no site composes an Org body
   * out of foreign text, and the one site that carries a body across files
   * (`buildSpecSkeleton`'s Purpose) refuses an unreadable one instead.
   */
  fenceMasksHeadings: boolean;

  LIST_BULLET: RegExp;
  /** Bullet naming a requirement, group 1 = the name. */
  BULLET_REQ: RegExp;
  /** RENAMED `FROM:` line, group 1 = the name. */
  RENAME_FROM: RegExp;
  /** RENAMED `TO:` line, group 1 = the name. */
  RENAME_TO: RegExp;
  /** Bold-labelled metadata line (`**ID**:` / `*ID*:`). */
  METADATA_LINE: RegExp;
  /** What-Changes bullet, group 1 = the spec, group 2 = the text. */
  DELTA_BULLET: RegExp;
  /** Checkbox task line, group 1 = the mark, group 2 = the text. */
  TASK_LINE: RegExp;
  /** The character class TASK_LINE accepts inside the brackets. */
  CHECKBOX_CLASS: string;

  /** FORK-ONLY. Property drawer opener, or null when the family has none. */
  PROPERTIES_OPEN: RegExp | null;
  /** FORK-ONLY. Drawer terminator, or null. */
  DRAWER_END: RegExp | null;
  /** FORK-ONLY. `:ID:` property, group 1 = the id. */
  ID_PROPERTY: RegExp | null;

  NORMATIVE_KEYWORDS: readonly string[];
  containsNormativeKeyword(text: string): boolean;

  newSpecHeader(capability: string): string;
  requirementsSectionLine(): string;
  purposeSectionLine(): string;
  deltaSectionLine(operation: DeltaOperation): string;
  requirementHeaderLine(name: string): string;
  scenarioHeaderLine(name: string): string;
  /** Stable identity minted for a requirement (`req-<capability>-<slug>`). */
  requirementId(capability: string, requirementName: string): string;
}

/** The subset of an artifact `resolveFormat` reads. */
export type FormatBearingArtifact = Pick<Artifact, 'format'>;

const NAME_PLACEHOLDER = '{name}';
const OPERATION_PLACEHOLDER = '{operation}';
const OPERATION_CAPTURE = `(${DELTA_OPERATIONS.join('|')})`;
const NAME_CAPTURE = '(.+?)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Literal text of a token, with runs of whitespace relaxed. */
function literalPattern(part: string): string {
  return escapeRegExp(part).replace(/\s+/gu, '\\s+');
}

/**
 * Compile a declared token into a recognizer. Only literal text and the
 * declared placeholder ever reach the pattern — a schema never supplies a
 * regex, which keeps the declaration out of the injection and backtracking
 * business.
 */
function compileToken(
  token: string,
  placeholder: string,
  capture: string,
  options: { anchorEnd: boolean }
): RegExp {
  const parts = token.split(placeholder).map(literalPattern);

  // A placeholder at the very end is preceded by optional whitespace, so
  // `Requirement:Name` reads the same as `Requirement: Name`.
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    const last = parts.length - 2;
    parts[last] = parts[last].replace(/\\s\+$/u, '\\s*');
  }

  const body = parts.join(capture);
  return options.anchorEnd
    ? new RegExp(`^${body}\\s*$`, 'i')
    : new RegExp(`^${body}`, 'im');
}

/** The built-in predicate, kept verbatim so the undeclared path is unchanged. */
const DEFAULT_NORMATIVE_PATTERN = /\b(SHALL|MUST)\b/;

/**
 * Compile declared keywords into a whole-word predicate.
 *
 * `\b` is ASCII-only: `/\bДОЛЖЕН\b/` matches nothing inside a Cyrillic phrase,
 * because neither side of the keyword is an ASCII word character. A declared
 * non-English keyword compiled that way would be a silent no-op — the failure
 * this block exists to end — so declared keywords get Unicode-aware boundaries.
 * The undeclared path keeps `DEFAULT_NORMATIVE_PATTERN` rather than this, so no
 * existing project's `SHALL` detection changes.
 */
function compileKeywords(keywords: readonly string[]): RegExp {
  const alternation = keywords.map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${alternation})(?![\\p{L}\\p{N}_])`, 'u');
}

function renderToken(token: string, placeholder: string, value: string): string {
  return token.split(placeholder).join(value);
}

/**
 * Recognizer for a requirement header seen as a parsed section TITLE, i.e.
 * after the heading marker has been consumed.
 *
 * Built from the requirement-header token, so a declared shape
 * (`## Functional Requirement: {name}`) and Org's `** Requirement: {name}` are
 * each judged by their own words. For the built-in Markdown token it compiles
 * to `/^Requirement:\s*\S/i` — the literal the delta reader carried before.
 */
function requirementTitlePattern(token: string, headingPrefix: RegExp): RegExp {
  const label = token.split(NAME_PLACEHOLDER)[0].replace(headingPrefix, '').trimEnd();
  return new RegExp(`^${literalPattern(label)}\\s*\\S`, 'i');
}

/** Deterministic fallback so a title with no Latin characters still mints. */
function fallbackSlug(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `r${hash.toString(36)}`;
}

/**
 * Kebab slug for a requirement identity. The grammar itself is not re-minted
 * here: the result is checked against the repository's one kebab id grammar.
 */
export function requirementSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return isKebabId(slug) ? slug : fallbackSlug(value);
}

/**
 * The delta headers as one advice fragment, in the format's own markup:
 * `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` for Markdown, `* …` for Org.
 *
 * One live copy on purpose. Every command that tells an author how to fix a
 * change quotes these headers, and a copy that stayed Markdown-only sent Org
 * authors to write a header their own parser cannot see — the defect this
 * function exists to make unrepeatable.
 */
export function deltaHeaders(format: ResolvedFormat): string {
  return format.deltaSectionLine('ADDED').replace('ADDED', DELTA_OPERATIONS.join('/'));
}

/** The scenario header up to its name, in the format's own markup: `#### Scenario:`. */
export function scenarioLabel(format: ResolvedFormat): string {
  return format.tokens.scenarioHeader.split('{name}')[0].trimEnd();
}

const MARKDOWN_TOKENS: FormatTokens = {
  requirementsSection: '## Requirements',
  requirementHeader: '### Requirement: {name}',
  scenarioHeader: '#### Scenario: {name}',
  deltaSection: '## {operation} Requirements',
  normativeKeywords: ['SHALL', 'MUST'],
  purposeSection: '## Purpose',
  specTitle: '# {name} Specification',
};

const ORG_TOKENS: FormatTokens = {
  requirementsSection: '* Requirements',
  requirementHeader: '** Requirement: {name}',
  scenarioHeader: '*** Scenario: {name}',
  deltaSection: '* {operation} Requirements',
  normativeKeywords: ['SHALL', 'MUST'],
  purposeSection: '* Purpose',
  specTitle: '#+TITLE: {name} Specification',
};

/**
 * Markdown recognizers. Every regex here is the literal the corresponding
 * parser carried before this module existed; that is what makes an undeclared
 * project byte-identical, and it is why they are written out rather than
 * compiled from the tokens above.
 */
const MARKDOWN_PATTERNS = {
  HEADING_ANY: /^(#{1,6})\s+(.+)$/,
  HEADING_PREFIX: /^(#{1,6})\s+/,
  H2_ANY: /^##\s+/,
  H2_TITLED: /^(##)\s+(.+)$/,
  H2_REQUIREMENTS: /^##\s+Requirements\s*$/i,
  H2_PURPOSE: /^##\s+Purpose\s*$/i,
  H2_DELTA: /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i,
  H2_DELTA_LOOSE: /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/im,
  H3_REQUIREMENT: /^###\s+Requirement:\s*(.+)\s*$/i,
  H3_REQUIREMENT_LOOSE: /^###\s*Requirement:\s*(.+)\s*$/i,
  H3_ANY_TITLED: /^###\s+(.+?)\s*$/,
  H4_SCENARIO: /^####\s+/,
  H4_SCENARIO_TITLED: /^ {0,3}####\s+Scenario:/i,
  LEVEL_TWO_HEADING: /^ {0,3}##(?!#)(?:[ \t]+|[ \t]*\r?$)/,
  NUMBERED_GROUP_HEADING: /^ {0,3}##[ \t]+(\d+)\.(?:[ \t]|\r?$)/,
  FENCE_OPEN: /^\s*(`{3,}|~{3,})/,
  FENCE_CLOSE: /^\s*(`{3,}|~{3,})\s*$/,
  LIST_BULLET: /^\s*[-*]\s/,
  BULLET_REQ: /^\s*-\s*`?###\s*Requirement:\s*(.+?)`?\s*$/,
  RENAME_FROM: /^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/,
  RENAME_TO: /^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/,
  METADATA_LINE: /^\*\*[^*]+\*\*:/,
  DELTA_BULLET: /^\s*-\s*\*\*([^*:]+)(?::\*\*|\*\*:)\s*(.+)$/,
  TASK_LINE: /^\s*[-*]\s*\[([\sxX])\]\s*(.*)/,
};

/**
 * Org recognizers. FORK-ONLY, all of them: a heading is a run of stars at
 * column zero, a block is fenced by `#+begin_`/`#+end_`, and `*` is never a
 * bullet because it is always structure.
 */
const ORG_PATTERNS = {
  HEADING_ANY: /^(\*{1,6})\s+(.+)$/,
  HEADING_PREFIX: /^(\*{1,6})\s+/,
  H2_ANY: /^\*(?!\*)\s+/,
  H2_TITLED: /^(\*)(?!\*)\s+(.+)$/,
  H2_REQUIREMENTS: /^\*\s+Requirements\s*$/i,
  H2_PURPOSE: /^\*\s+Purpose\s*$/i,
  H2_DELTA: /^\*\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i,
  H2_DELTA_LOOSE: /^\*\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/im,
  H3_REQUIREMENT: /^\*\*\s+Requirement:\s*(.+)\s*$/i,
  H3_REQUIREMENT_LOOSE: /^\*\*\s*Requirement:\s*(.+)\s*$/i,
  H3_ANY_TITLED: /^\*\*\s+(.+?)\s*$/,
  H4_SCENARIO: /^\*{3}\s+/,
  H4_SCENARIO_TITLED: /^\*{3}\s+Scenario:/i,
  LEVEL_TWO_HEADING: /^\*(?!\*)(?:[ \t]+|[ \t]*\r?$)/,
  NUMBERED_GROUP_HEADING: /^\*[ \t]+(\d+)\.(?:[ \t]|\r?$)/,
  FENCE_OPEN: /^\s*#\+begin_(src|example|quote|export)\b/i,
  FENCE_CLOSE: /^\s*#\+end_(src|example|quote|export)\s*$/i,
  LIST_BULLET: /^\s*[-+]\s/,
  BULLET_REQ: /^\s*-\s*[=~]?\*\*\s*Requirement:\s*(.+?)[=~]?\s*$/,
  RENAME_FROM: /^\s*-?\s*FROM:\s*[=~]?\*\*\s*Requirement:\s*(.+?)[=~]?\s*$/,
  RENAME_TO: /^\s*-?\s*TO:\s*[=~]?\*\*\s*Requirement:\s*(.+?)[=~]?\s*$/,
  METADATA_LINE: /^\*[^*\s][^*]*\*:/,
  DELTA_BULLET: /^\s*-\s*\*([^*:]+)(?::\*|\*:)\s*(.+)$/,
  TASK_LINE: /^\s*[-+]\s*\[([\sxX-])\]\s*(.*)/,
};

const ORG_PROPERTIES_OPEN = /^\s*:PROPERTIES:\s*$/i;
const ORG_DRAWER_END = /^\s*:END:\s*$/i;
const ORG_ID_PROPERTY = /^\s*:ID:\s+(.+?)\s*$/i;

function buildFormat(markup: MarkupFamily, declared: ArtifactFormatDeclaration): ResolvedFormat {
  const org = markup === 'org';
  const patterns = org ? ORG_PATTERNS : MARKDOWN_PATTERNS;
  const defaults = org ? ORG_TOKENS : MARKDOWN_TOKENS;

  const tokens: FormatTokens = {
    requirementsSection: declared.requirementsSection ?? defaults.requirementsSection,
    requirementHeader: declared.requirementHeader ?? defaults.requirementHeader,
    scenarioHeader: declared.scenarioHeader ?? defaults.scenarioHeader,
    deltaSection: declared.deltaSection ?? defaults.deltaSection,
    normativeKeywords: declared.normativeKeywords ?? defaults.normativeKeywords,
    purposeSection: defaults.purposeSection,
    specTitle: defaults.specTitle,
  };

  // A declared token replaces the family literal it corresponds to; an
  // undeclared one keeps the literal, which is the no-change path.
  const H2_REQUIREMENTS = declared.requirementsSection
    ? compileToken(tokens.requirementsSection, NAME_PLACEHOLDER, NAME_CAPTURE, { anchorEnd: true })
    : patterns.H2_REQUIREMENTS;
  const H3_REQUIREMENT = declared.requirementHeader
    ? compileToken(tokens.requirementHeader, NAME_PLACEHOLDER, NAME_CAPTURE, { anchorEnd: true })
    : patterns.H3_REQUIREMENT;
  const H4_SCENARIO_TITLED = declared.scenarioHeader
    ? compileToken(tokens.scenarioHeader, NAME_PLACEHOLDER, NAME_CAPTURE, { anchorEnd: true })
    : patterns.H4_SCENARIO_TITLED;
  const H2_DELTA = declared.deltaSection
    ? compileToken(tokens.deltaSection, OPERATION_PLACEHOLDER, OPERATION_CAPTURE, {
        anchorEnd: true,
      })
    : patterns.H2_DELTA;
  const H2_DELTA_LOOSE = declared.deltaSection
    ? compileToken(tokens.deltaSection, OPERATION_PLACEHOLDER, OPERATION_CAPTURE, {
        anchorEnd: false,
      })
    : patterns.H2_DELTA_LOOSE;

  const normativeKeywords = tokens.normativeKeywords;
  const normativePattern = declared.normativeKeywords
    ? compileKeywords(normativeKeywords)
    : DEFAULT_NORMATIVE_PATTERN;
  const markerDepthOffset = org ? 1 : 0;

  const format: ResolvedFormat = {
    markup,
    SPEC_FILE: org ? 'spec.org' : 'spec.md',
    tokens,

    HEADING_ANY: patterns.HEADING_ANY,
    HEADING_PREFIX: patterns.HEADING_PREFIX,
    headingLevel(line: string): number | null {
      const match = line.match(patterns.HEADING_PREFIX);
      return match ? match[1].length + markerDepthOffset : null;
    },

    H2_ANY: patterns.H2_ANY,
    H2_TITLED: patterns.H2_TITLED,
    H2_REQUIREMENTS,
    H2_PURPOSE: patterns.H2_PURPOSE,
    H2_DELTA,
    H2_DELTA_LOOSE,
    H3_REQUIREMENT,
    // The loose twin exists only to tolerate a missing space in the built-in
    // literal. A declared token is the author's own shape, so both anchors are
    // that shape rather than a silently widened variant of it.
    H3_REQUIREMENT_LOOSE: declared.requirementHeader
      ? H3_REQUIREMENT
      : patterns.H3_REQUIREMENT_LOOSE,
    H3_ANY_TITLED: patterns.H3_ANY_TITLED,
    REQUIREMENT_TITLE: requirementTitlePattern(
      tokens.requirementHeader,
      patterns.HEADING_PREFIX
    ),
    H4_SCENARIO: patterns.H4_SCENARIO,
    H4_SCENARIO_TITLED,
    LEVEL_TWO_HEADING: patterns.LEVEL_TWO_HEADING,
    NUMBERED_GROUP_HEADING: patterns.NUMBERED_GROUP_HEADING,

    FENCE_OPEN: patterns.FENCE_OPEN,
    FENCE_CLOSE: patterns.FENCE_CLOSE,
    fenceMasksHeadings: !org,

    LIST_BULLET: patterns.LIST_BULLET,
    BULLET_REQ: patterns.BULLET_REQ,
    RENAME_FROM: patterns.RENAME_FROM,
    RENAME_TO: patterns.RENAME_TO,
    METADATA_LINE: patterns.METADATA_LINE,
    DELTA_BULLET: patterns.DELTA_BULLET,
    TASK_LINE: patterns.TASK_LINE,
    CHECKBOX_CLASS: org ? '[\\sxX-]' : '[\\sxX]',

    PROPERTIES_OPEN: org ? ORG_PROPERTIES_OPEN : null,
    DRAWER_END: org ? ORG_DRAWER_END : null,
    ID_PROPERTY: org ? ORG_ID_PROPERTY : null,

    NORMATIVE_KEYWORDS: normativeKeywords,
    containsNormativeKeyword(text: string): boolean {
      return normativePattern.test(text);
    },

    newSpecHeader(capability: string): string {
      return renderToken(tokens.specTitle, NAME_PLACEHOLDER, capability);
    },
    requirementsSectionLine(): string {
      return tokens.requirementsSection;
    },
    purposeSectionLine(): string {
      return tokens.purposeSection;
    },
    deltaSectionLine(operation: DeltaOperation): string {
      return renderToken(tokens.deltaSection, OPERATION_PLACEHOLDER, operation);
    },
    requirementHeaderLine(name: string): string {
      return renderToken(tokens.requirementHeader, NAME_PLACEHOLDER, name);
    },
    scenarioHeaderLine(name: string): string {
      return renderToken(tokens.scenarioHeader, NAME_PLACEHOLDER, name);
    },
    requirementId(capability: string, requirementName: string): string {
      return `req-${requirementSlug(capability)}-${requirementSlug(requirementName)}`;
    },
  };

  return Object.freeze(format);
}

/** What an artifact may declare; the zod shape lives with `ArtifactSchema`. */
type ArtifactFormatDeclaration = NonNullable<Artifact['format']>;

const EMPTY_DECLARATION: ArtifactFormatDeclaration = {};
const DEFAULT_FORMAT = buildFormat('markdown', EMPTY_DECLARATION);

/**
 * Resolve the format one artifact's content is written in.
 *
 * An absent artifact, an artifact without a `format` block, and an artifact
 * whose block declares nothing all resolve to the same built-in defaults, so a
 * call site that has no schema in hand — direct file validation, legacy paths —
 * keeps today's behavior without a nullable format.
 */
export function resolveFormat(artifact?: FormatBearingArtifact | null): ResolvedFormat {
  const declared = artifact?.format;
  if (!declared) {
    return DEFAULT_FORMAT;
  }
  return buildFormat(declared.markup ?? 'markdown', declared);
}

/** The built-in defaults, for call sites that want them by name. */
export function defaultFormat(): ResolvedFormat {
  return DEFAULT_FORMAT;
}

/**
 * Everything wrong with an artifact's `format` block, as messages naming the
 * artifact and the field.
 *
 * A block that cannot be honored is an error at load rather than a surprise at
 * parse time: the author of a dropped declaration cannot tell it from one that
 * took effect. Unknown keys are caught earlier, by the strict zod object.
 */
export function collectFormatIssues(artifact: Artifact): string[] {
  const declared = artifact.format;
  if (!declared) {
    return [];
  }

  const issues: string[] = [];
  const where = `artifact '${artifact.id}'`;

  for (const field of ['requirementHeader', 'scenarioHeader'] as const) {
    const token = declared[field];
    if (token !== undefined && !token.includes(NAME_PLACEHOLDER)) {
      issues.push(`${where}: format.${field} must contain the ${NAME_PLACEHOLDER} placeholder`);
    }
  }

  if (declared.deltaSection !== undefined && !declared.deltaSection.includes(OPERATION_PLACEHOLDER)) {
    issues.push(
      `${where}: format.deltaSection must contain the ${OPERATION_PLACEHOLDER} placeholder`
    );
  }

  for (const field of [
    'requirementsSection',
    'requirementHeader',
    'scenarioHeader',
    'deltaSection',
  ] as const) {
    const token = declared[field];
    if (token !== undefined && token.trim().length === 0) {
      issues.push(`${where}: format.${field} must not be empty`);
    }
  }

  if (declared.normativeKeywords !== undefined) {
    if (declared.normativeKeywords.length === 0) {
      issues.push(`${where}: format.normativeKeywords must list at least one keyword`);
    }
    if (declared.normativeKeywords.some(keyword => keyword.trim().length === 0)) {
      issues.push(`${where}: format.normativeKeywords must not contain an empty keyword`);
    }
  }

  // Two tokens with the same shape leave the reader unable to tell them apart.
  const seen = new Map<string, string>();
  for (const field of [
    'requirementsSection',
    'requirementHeader',
    'scenarioHeader',
    'deltaSection',
  ] as const) {
    const token = declared[field]?.trim();
    if (!token) continue;
    const previous = seen.get(token);
    if (previous) {
      issues.push(
        `${where}: format.${field} declares the same token as format.${previous} ('${token}')`
      );
    } else {
      seen.set(token, field);
    }
  }

  return issues;
}
