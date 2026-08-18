import { buildCodeFenceMask, buildStructureMask } from './code-fence.js';
import { defaultFormat, type ResolvedFormat } from './grammar.js';

export interface MainSpecStructureIssue {
  kind: 'delta-header' | 'requirement-outside-requirements' | 'duplicate-requirement';
  line: number;
  header: string;
  message: string;
}

export function findMainSpecStructureIssues(
  content: string,
  format: ResolvedFormat = defaultFormat()
): MainSpecStructureIssue[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // Structure mask, not the plain fence mask: in Org a heading inside
  // `#+begin_src` is still a heading, so the reader must see it here exactly as
  // the parsers do, or a duplicate would slip past this check and then be
  // parsed anyway.
  const structural = buildStructureMask(lines, format);
  const issues: MainSpecStructureIssue[] = [];
  const requirementLines = new Map<string, number>();

  const requirementsHeaderIndex = lines.findIndex(
    (line, i) => !structural[i] && format.H2_REQUIREMENTS.test(line)
  );
  let requirementsEndIndex = lines.length;

  if (requirementsHeaderIndex !== -1) {
    for (let i = requirementsHeaderIndex + 1; i < lines.length; i++) {
      if (!structural[i] && format.H2_ANY.test(lines[i])) {
        requirementsEndIndex = i;
        break;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || structural[i]) {
      continue;
    }

    if (format.H2_DELTA.test(line)) {
      issues.push({
        kind: 'delta-header',
        line: i + 1,
        header: trimmed,
        message:
          `Main spec contains delta header "${trimmed}". ` +
          `Delta headers are only valid inside openspec/changes/<name>/specs/<capability-path>/${format.SPEC_FILE} ` +
          `and truncate the parsed ${format.tokens.requirementsSection} section.`,
      });
      continue;
    }

    const requirementMatch = line.match(format.H3_REQUIREMENT);
    if (!requirementMatch) {
      continue;
    }

    const insideRequirements =
      requirementsHeaderIndex !== -1 &&
      i > requirementsHeaderIndex &&
      i < requirementsEndIndex;

    if (!insideRequirements) {
      issues.push({
        kind: 'requirement-outside-requirements',
        line: i + 1,
        header: trimmed,
        message:
          `Requirement header "${trimmed}" appears outside the main ${format.tokens.requirementsSection} section. ` +
          'Main specs only parse requirements inside that section, so this requirement is currently invisible to validate, list, and archive.',
      });
      continue;
    }

    const requirementName = requirementMatch[1].trim();
    const previousLine = requirementLines.get(requirementName);
    if (previousLine !== undefined) {
      issues.push({
        kind: 'duplicate-requirement',
        line: i + 1,
        header: trimmed,
        message:
          `Requirement header "${trimmed}" duplicates the requirement declared on line ${previousLine}. ` +
          'Requirement names must be unique so spec updates cannot discard one block while updating another.',
      });
    } else {
      requirementLines.set(requirementName, i + 1);
    }
  }

  return issues;
}

export function stripFencedCodeBlocksPreservingLines(content: string): string {
  const lines = content.split('\n');
  const mask = buildCodeFenceMask(lines);
  return lines.map((line, i) => (mask[i] ? '' : line)).join('\n');
}
