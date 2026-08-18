/**
 * Shared, fence-aware requirement-reading helpers.
 *
 * The requirement reader used to be implemented twice — once for main specs
 * (`MarkdownParser.parseRequirements`) and once for change deltas
 * (`Validator.extractRequirementText` / `countScenarios`) — and the two drifted
 * apart. These helpers are the single source of truth for requirement-body
 * extraction, scenario counting, and normative-keyword detection in
 * `validate <change>`, `validate <spec>`, and `archive`.
 *
 * Every recognizer they use comes from the resolved format, so the same reader
 * serves an artifact written in any declared shape. Callers that pass no format
 * get the Markdown defaults.
 */

// Re-exported so existing importers keep working; the single implementation
// lives in code-fence.ts.
export { buildCodeFenceMask, buildStructureMask } from './code-fence.js';
import { buildCodeFenceMask, buildStructureMask } from './code-fence.js';
import { defaultFormat, type ResolvedFormat } from './grammar.js';

/**
 * @deprecated Markdown-only aliases kept for importers that predate the format
 * parameter. They are the DEFAULT format's recognizers, not independent
 * literals, so they must never be used as the oracle in an assertion about
 * whether the default format reproduces the historical Markdown regexes — such
 * an assertion would be comparing a value with itself. Write the literal out in
 * the test instead.
 */
export const SCENARIO_HEADER = defaultFormat().H4_SCENARIO;

/** @deprecated See `SCENARIO_HEADER`. Prefer `format.containsNormativeKeyword`. */
export function containsShallOrMust(text: string): boolean {
  return defaultFormat().containsNormativeKeyword(text);
}

/**
 * Extract the full requirement body from the lines that follow a requirement
 * header (the lines may include scenarios and fenced blocks).
 *
 * Captures every body line from the start up to the first header found on a
 * line whose structure is visible — usually the first scenario header, but also
 * a stray divider at requirement depth that the delta reader absorbed into the
 * block — skipping blank lines and any line inside a fenced block. Metadata
 * lines are skipped only when other body text remains: a requirement written
 * entirely as `**Constraint**: The system MUST ...` keeps that line as its body.
 * Captured lines are trimmed and joined with newlines so a requirement whose
 * text wraps across lines — or whose normative keyword lands on a later line —
 * is read in full.
 *
 * The boundary is tested before the fenced-content skip because the two masks
 * differ in Org: a heading inside `#+begin_src` is still a heading and still
 * ends the body, while the block's prose is not body text. In Markdown the two
 * masks are the same, so a fenced header is skipped as content exactly as
 * before.
 */
export function extractRequirementBody(
  bodyLines: string[],
  format: ResolvedFormat = defaultFormat()
): string {
  const contentMask = buildCodeFenceMask(bodyLines, format);
  const structureMask = buildStructureMask(bodyLines, format);
  const captured: string[] = [];
  const metadata: string[] = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    // First scenario or stray divider.
    if (!structureMask[i] && format.HEADING_PREFIX.test(line)) break;
    if (contentMask[i]) continue; // inside a fenced block
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // blank
    if (format.METADATA_LINE.test(trimmed)) {
      metadata.push(trimmed); // **ID**: / **Priority**: ...
      continue;
    }
    captured.push(trimmed);
  }

  if (captured.length > 0) return captured.join('\n');
  return metadata.join('\n'); // metadata-only body: the metadata IS the body
}

/**
 * Parser/display fallback for a requirement block with no body text. This is
 * what lets a bare `### The system SHALL ...` header remain readable on the
 * spec path (the title is the requirement). Validator body-keyword checks for
 * canonical requirement blocks use `extractRequirementBody` directly so a
 * keyword that appears only in the header still receives the #1156/#1280
 * body-keyword hint.
 */
export function extractRequirementText(
  headerTitle: string,
  bodyLines: string[],
  format: ResolvedFormat = defaultFormat()
): string {
  return extractRequirementBody(bodyLines, format) || headerTitle.trim();
}

/**
 * Count the real scenarios in a requirement block: scenario-depth headers whose
 * structure is visible. A scenario header that lives inside a fenced Markdown
 * example is not a real scenario and is not counted; in Org the same header is
 * counted, because the fence does not hide it there.
 */
export function countScenarios(
  bodyLines: string[],
  format: ResolvedFormat = defaultFormat()
): number {
  const mask = buildStructureMask(bodyLines, format);
  let count = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    if (mask[i]) continue;
    if (format.H4_SCENARIO.test(bodyLines[i])) count++;
  }
  return count;
}
