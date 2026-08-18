import { buildStructureMask } from './code-fence.js';
import { defaultFormat, type DeltaOperation, type ResolvedFormat } from './grammar.js';

export interface RequirementBlock {
  headerLine: string; // e.g., '### Requirement: Something'
  name: string; // e.g., 'Something'
  raw: string; // full block including headerLine and following content
}

export interface RequirementsSectionParts {
  before: string;
  headerLine: string; // the '## Requirements' line
  preamble: string; // content between headerLine and first requirement block
  bodyBlocks: RequirementBlock[]; // parsed requirement blocks in order
  after: string;
}

export function normalizeRequirementName(name: string): string {
  return name.trim();
}

/**
 * Case- and whitespace-insensitive fold of a requirement name. Requirement
 * matching itself is case-sensitive (normalizeRequirementName); this fold
 * exists only for typo detection - near-miss REMOVED headers and the
 * RENAMED+REMOVED cross-section conflict - where two spellings that differ
 * only in case or interior whitespace mean a mistake, never two requirements.
 */
export function foldRequirementName(name: string): string {
  return normalizeRequirementName(name).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The section title a delta operation is written under, without the heading
 * marker: `## ADDED Requirements` and `* ADDED Requirements` both title their
 * section `ADDED Requirements`, which is what the section index is keyed by.
 */
function deltaSectionTitle(operation: DeltaOperation, format: ResolvedFormat): string {
  return format.deltaSectionLine(operation).replace(format.HEADING_PREFIX, '');
}

/**
 * Extracts the Requirements section from a spec file and parses requirement blocks.
 */
export function extractRequirementsSection(
  content: string,
  format: ResolvedFormat = defaultFormat()
): RequirementsSectionParts {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');
  const fenceMask = buildStructureMask(lines, format);
  const reqHeaderIndex = lines.findIndex(
    (l, i) => !fenceMask[i] && format.H2_REQUIREMENTS.test(l)
  );

  if (reqHeaderIndex === -1) {
    // No requirements section; create an empty one at the end
    const before = content.trimEnd();
    const headerLine = format.requirementsSectionLine();
    return {
      before: before ? before + '\n\n' : '',
      headerLine,
      preamble: '',
      bodyBlocks: [],
      after: '\n',
    };
  }

  // Find end of this section: next line that starts with '## ' at same or higher level
  let endIndex = lines.length;
  for (let i = reqHeaderIndex + 1; i < lines.length; i++) {
    if (!fenceMask[i] && format.H2_ANY.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const before = lines.slice(0, reqHeaderIndex).join('\n');
  const headerLine = lines[reqHeaderIndex];
  const sectionBodyLines = lines.slice(reqHeaderIndex + 1, endIndex);
  const sectionBodyMask = fenceMask.slice(reqHeaderIndex + 1, endIndex);
  const isRequirementHeader = (cursor: number): boolean =>
    !sectionBodyMask[cursor] && format.H3_REQUIREMENT_LOOSE.test(sectionBodyLines[cursor]);
  const isTopLevelHeader = (cursor: number): boolean =>
    !sectionBodyMask[cursor] && format.H2_ANY.test(sectionBodyLines[cursor]);

  // Parse requirement blocks within section body
  const blocks: RequirementBlock[] = [];
  let cursor = 0;
  let preambleLines: string[] = [];

  // Collect preamble lines until first requirement header
  while (cursor < sectionBodyLines.length && !isRequirementHeader(cursor)) {
    preambleLines.push(sectionBodyLines[cursor]);
    cursor++;
  }

  while (cursor < sectionBodyLines.length) {
    const headerLineCandidate = sectionBodyLines[cursor];
    if (!isRequirementHeader(cursor)) {
      // Not a requirement header; skip line defensively
      cursor++;
      continue;
    }
    const headerMatch = headerLineCandidate.match(format.H3_REQUIREMENT_LOOSE)!;
    const name = normalizeRequirementName(headerMatch[1]);
    cursor++;
    // Gather lines until next requirement header or end of section
    const bodyLines: string[] = [headerLineCandidate];
    while (cursor < sectionBodyLines.length && !isRequirementHeader(cursor) && !isTopLevelHeader(cursor)) {
      bodyLines.push(sectionBodyLines[cursor]);
      cursor++;
    }
    const raw = bodyLines.join('\n').trimEnd();
    blocks.push({ headerLine: headerLineCandidate, name, raw });
  }

  const after = lines.slice(endIndex).join('\n');
  const preamble = preambleLines.join('\n').trimEnd();

  return {
    before: before.trimEnd() ? before + '\n' : before,
    headerLine,
    preamble,
    bodyBlocks: blocks,
    after: after.startsWith('\n') ? after : '\n' + after,
  };
}

/**
 * A level-3 header inside `## ADDED`/`## MODIFIED Requirements` that is not a
 * canonical `### Requirement:` header, recorded at the moment the delta reader
 * skips over it. Surfaced as an INFO note by `validate <change>` (#498).
 */
export interface SkippedHeader {
  header: string; // header text without the leading ###
  section: string; // the ## section title as written
  line: number; // 1-based line number in the delta file
}

export interface DeltaPlan {
  added: RequirementBlock[];
  modified: RequirementBlock[];
  removed: string[]; // requirement names
  renamed: Array<{ from: string; to: string }>;
  skippedHeaders: SkippedHeader[]; // non-canonical ### headers the reader skipped
  sectionPresence: {
    added: boolean;
    modified: boolean;
    removed: boolean;
    renamed: boolean;
  };
}

function normalizeLineEndings(content: string): string {
  // Strip a UTF-8 BOM: Windows editors and PowerShell redirects prepend one,
  // and it would keep the first line's `## ADDED Requirements` from matching.
  return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * A slice of a document represented as its lines plus a parallel mask marking
 * lines that live inside fenced code blocks (which must be ignored when
 * detecting Markdown structure).
 */
interface SectionBody {
  lines: string[];
  fenceMask: boolean[];
  bodyStartLine: number;
}

/**
 * Parse a delta-formatted spec change file content into a DeltaPlan with raw blocks.
 */
export function parseDeltaSpec(
  content: string,
  format: ResolvedFormat = defaultFormat()
): DeltaPlan {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split('\n');
  const fenceMask = buildStructureMask(lines, format);
  const sections = splitTopLevelSections(lines, fenceMask, format);
  const addedLookup = getSectionCaseInsensitive(sections, deltaSectionTitle('ADDED', format));
  const modifiedLookup = getSectionCaseInsensitive(sections, deltaSectionTitle('MODIFIED', format));
  const removedLookup = getSectionCaseInsensitive(sections, deltaSectionTitle('REMOVED', format));
  const renamedLookup = getSectionCaseInsensitive(sections, deltaSectionTitle('RENAMED', format));
  const skippedHeaders: SkippedHeader[] = [];
  const added = parseRequirementBlocksFromSection(addedLookup.body, format, {
    section: addedLookup.title,
    bodyStartLine: addedLookup.bodyStartLine,
    sink: skippedHeaders,
  });
  const modified = parseRequirementBlocksFromSection(modifiedLookup.body, format, {
    section: modifiedLookup.title,
    bodyStartLine: modifiedLookup.bodyStartLine,
    sink: skippedHeaders,
  });
  const removedNames = parseRemovedNames(removedLookup.body, format);
  const renamedPairs = parseRenamedPairs(renamedLookup.body, format);
  skippedHeaders.sort((a, b) => a.line - b.line);
  return {
    added,
    modified,
    removed: removedNames,
    renamed: renamedPairs,
    skippedHeaders,
    sectionPresence: {
      added: addedLookup.found,
      modified: modifiedLookup.found,
      removed: removedLookup.found,
      renamed: renamedLookup.found,
    },
  };
}

function splitTopLevelSections(
  lines: string[],
  fenceMask: boolean[],
  format: ResolvedFormat
): Record<string, SectionBody> {
  const result: Record<string, SectionBody> = {};
  const indices: Array<{ title: string; index: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const m = lines[i].match(format.H2_TITLED);
    if (m) {
      indices.push({ title: m[2].trim(), index: i });
    }
  }
  for (let i = 0; i < indices.length; i++) {
    const current = indices[i];
    const next = indices[i + 1];
    const end = next ? next.index : lines.length;
    result[current.title] = {
      lines: lines.slice(current.index + 1, end),
      fenceMask: fenceMask.slice(current.index + 1, end),
      bodyStartLine: current.index + 2,
    };
  }
  return result;
}

const EMPTY_SECTION_BODY: SectionBody = { lines: [], fenceMask: [], bodyStartLine: 0 };

function getSectionCaseInsensitive(
  sections: Record<string, SectionBody>,
  desired: string
): { title: string; body: SectionBody; bodyStartLine: number; found: boolean } {
  const target = desired.toLowerCase();
  for (const [title, body] of Object.entries(sections)) {
    if (title.toLowerCase() === target) {
      return { title, body, bodyStartLine: body.bodyStartLine, found: true };
    }
  }
  return { title: desired, body: EMPTY_SECTION_BODY, bodyStartLine: 0, found: false };
}

function parseRequirementBlocksFromSection(
  sectionBody: SectionBody,
  format: ResolvedFormat,
  skipped?: { section: string; bodyStartLine: number; sink: SkippedHeader[] }
): RequirementBlock[] {
  const { lines, fenceMask } = sectionBody;
  if (lines.length === 0) return [];
  const isRequirementHeader = (i: number): boolean =>
    !fenceMask[i] && format.H3_REQUIREMENT_LOOSE.test(lines[i]);
  const isTopLevelHeader = (i: number): boolean => !fenceMask[i] && format.H2_ANY.test(lines[i]);
  const recordIfSkippedHeader = (index: number) => {
    if (!skipped || fenceMask[index]) return;
    const h3 = lines[index].match(format.H3_ANY_TITLED);
    if (h3 && !format.H3_REQUIREMENT_LOOSE.test(lines[index])) {
      skipped.sink.push({
        header: h3[1].trim(),
        section: skipped.section,
        line: skipped.bodyStartLine + index,
      });
    }
  };
  const blocks: RequirementBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    // Seek next requirement header
    while (i < lines.length && !isRequirementHeader(i)) {
      recordIfSkippedHeader(i);
      i++;
    }
    if (i >= lines.length) break;
    const headerLine = lines[i];
    const m = headerLine.match(format.H3_REQUIREMENT_LOOSE);
    if (!m) { i++; continue; }
    const name = normalizeRequirementName(m[1]);
    const buf: string[] = [headerLine];
    i++;
    while (i < lines.length && !isRequirementHeader(i) && !isTopLevelHeader(i)) {
      recordIfSkippedHeader(i);
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ headerLine, name, raw: buf.join('\n').trimEnd() });
  }
  return blocks;
}

function parseRemovedNames(sectionBody: SectionBody, format: ResolvedFormat): string[] {
  const { lines, fenceMask } = sectionBody;
  if (lines.length === 0) return [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i];
    const m = line.match(format.H3_REQUIREMENT_LOOSE);
    if (m) {
      names.push(normalizeRequirementName(m[1]));
      continue;
    }
    // Also support bullet list of headers
    const bullet = line.match(format.BULLET_REQ);
    if (bullet) {
      names.push(normalizeRequirementName(bullet[1]));
    }
  }
  return names;
}

function parseRenamedPairs(
  sectionBody: SectionBody,
  format: ResolvedFormat
): Array<{ from: string; to: string }> {
  const { lines, fenceMask } = sectionBody;
  if (lines.length === 0) return [];
  const pairs: Array<{ from: string; to: string }> = [];
  let current: { from?: string; to?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue;
    const line = lines[i];
    const fromMatch = line.match(format.RENAME_FROM);
    const toMatch = line.match(format.RENAME_TO);
    if (fromMatch) {
      current.from = normalizeRequirementName(fromMatch[1]);
    } else if (toMatch) {
      current.to = normalizeRequirementName(toMatch[1]);
      if (current.from && current.to) {
        pairs.push({ from: current.from, to: current.to });
        current = {};
      }
    }
  }
  return pairs;
}

interface ScenarioBlock {
  name: string;
  raw: string;
}

/**
 * Scenario names the current requirement block has and the incoming
 * (MODIFIED) block does not. A MODIFIED requirement replaces the whole block,
 * so every name reported here would be dropped from the main spec.
 *
 * Shared by archive (which refuses to apply the block) and validate (which
 * reports the same loss at authoring time, #1477), so the two cannot disagree
 * about what counts as a dropped scenario.
 */
export function findMissingCurrentScenarios(
  current: RequirementBlock,
  incoming: RequirementBlock,
  format: ResolvedFormat = defaultFormat()
): string[] {
  // Multiplicity-aware: a name present N times in current and M times in
  // incoming means max(0, N - M) instances are missing. Set membership would
  // treat N>M as fully covered and let archive silently drop duplicates
  // (residual #1246 / duplicate-scenario-name blind spot).
  const remainingIncoming = new Map<string, number>();
  for (const scenario of parseScenarioBlocks(incoming.raw, format)) {
    const name = scenario.name;
    remainingIncoming.set(name, (remainingIncoming.get(name) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const scenario of parseScenarioBlocks(current.raw, format)) {
    const name = scenario.name;
    const remaining = remainingIncoming.get(name) ?? 0;
    if (remaining > 0) {
      remainingIncoming.set(name, remaining - 1);
    } else {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Any scenario-depth header on the given (masked) line. Reuses the spec path's
 * `H4_SCENARIO` so the two counters cannot drift apart.
 */
function scenarioHeaderAt(
  lines: string[],
  mask: boolean[],
  index: number,
  format: ResolvedFormat
): boolean {
  return !mask[index] && format.H4_SCENARIO.test(lines[index]);
}

/**
 * The scenario name for a scenario-depth header, matching the label the author
 * reads: the header text with the leading marker, an optional CommonMark
 * closing `#` run (`#### Foo ####` renders as `Foo`), and the format's
 * `Scenario:` label stripped. Both the current and incoming blocks run through
 * here, so the comparison in findMissingCurrentScenarios stays internally
 * consistent regardless of label — and two headers that render to the same
 * title (one ATX-closed, one not) are not mistaken for a dropped scenario.
 */
function scenarioNameAt(line: string, format: ResolvedFormat): string {
  // `H4_SCENARIO_TITLED` removes the marker AND the label in one step; a header
  // that carries no label (`#### Edge case`) keeps the line unchanged, so the
  // marker-only recognizer takes over.
  const labelled = line.replace(format.H4_SCENARIO_TITLED, '');
  const withoutHeader = labelled === line ? line.replace(format.H4_SCENARIO, '') : labelled;
  return (
    withoutHeader
      // Optional ATX closing sequence. CommonMark only treats a trailing `#` run
      // as a close when it is preceded by a space or tab — not any Unicode space —
      // so this uses `[ \t]`, not `\s`. A looser `\s` could strip a `#` run after
      // an exotic space (e.g. NBSP) that CommonMark keeps, folding two distinct
      // scenario names into one and masking a real loss. `[ \t]` keeps the fold
      // faithful to how the header actually renders.
      .replace(/[ \t]+#+[ \t]*$/, '')
      .trim()
  );
}

function parseScenarioBlocks(requirementRaw: string, format: ResolvedFormat): ScenarioBlock[] {
  const lines = requirementRaw.replace(/\r\n?/g, '\n').split('\n');
  // A scenario is ANY scenario-depth header whose structure is visible, matching
  // the spec path's `H4_SCENARIO` / countScenarios (requirement-text.ts)
  // exactly — not only a `Scenario:`-labelled one. The two MUST agree: a child
  // at that depth whose header is not literally `Scenario:` (e.g.
  // `#### Edge case`) is still a scenario the spec path counts, so a MODIFIED
  // block that drops it would otherwise slip past this loss check and be
  // deleted by archive with no error. A header inside a fenced Markdown example
  // is masked out, matching countScenarios.
  const mask = buildStructureMask(lines, format);
  const scenarios: ScenarioBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!scenarioHeaderAt(lines, mask, index, format)) {
      index++;
      continue;
    }

    const start = index;
    const name = scenarioNameAt(lines[index], format);
    index++;
    while (index < lines.length && !scenarioHeaderAt(lines, mask, index, format)) {
      index++;
    }

    scenarios.push({
      name,
      raw: lines.slice(start, index).join('\n').trimEnd(),
    });
  }

  return scenarios;
}
