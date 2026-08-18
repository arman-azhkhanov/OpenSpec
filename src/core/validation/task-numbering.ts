import { parseTaskLines } from '../../utils/task-progress.js';
import { defaultFormat, type ResolvedFormat } from '../parsers/grammar.js';

export interface TaskNumberingDocument {
  path: string;
  content: string;
}

export interface TaskNumberingIssue {
  path: string;
  line: number;
  message: string;
}

interface TaskLocation {
  path: string;
  line: number;
}

const TASK_ID = /^(\d+(?:\.\d+)+(?:[A-Za-z]+)?)(?=\s|$)/;

/**
 * Finds ambiguous task references across the task files tracked by a change.
 * Numbering is interpreted only inside numbered top-level groups (`## N.` in
 * Markdown). Unnumbered sections, unnumbered tasks, and files without numbered
 * groups are intentionally ignored. The group heading and the task line are
 * recognized through the format the task files are written in, so a change
 * whose tasks artifact declares another markup is linted, not skipped.
 */
export function findTaskNumberingIssues(
  documents: readonly TaskNumberingDocument[],
  format: ResolvedFormat = defaultFormat()
): TaskNumberingIssue[] {
  const issues: TaskNumberingIssue[] = [];
  const firstLocationById = new Map<string, TaskLocation>();

  for (const document of documents) {
    const lines = document.content.split('\n');
    if (!lines.some((line) => format.NUMBERED_GROUP_HEADING.test(line))) continue;

    let currentGroup: string | undefined;

    lines.forEach((line, index) => {
      if (format.LEVEL_TWO_HEADING.test(line)) {
        currentGroup = line.match(format.NUMBERED_GROUP_HEADING)?.[1];
      }
      if (currentGroup === undefined) return;

      const task = parseTaskLines(line, format)[0];
      const id = task?.description.match(TASK_ID)?.[1];
      if (!id) return;

      const lineNumber = index + 1;
      const taskGroup = id.split('.')[0];
      const normalizedTaskGroup = taskGroup.replace(/^0+(?=\d)/, '');
      const normalizedCurrentGroup = currentGroup.replace(/^0+(?=\d)/, '');
      if (normalizedTaskGroup !== normalizedCurrentGroup) {
        issues.push({
          path: document.path,
          line: lineNumber,
          message: `Task "${id}" is under group ${currentGroup}, but its leading number points to group ${taskGroup}. Move it to group ${taskGroup} or renumber it.`,
        });
      }

      const firstLocation = firstLocationById.get(id);
      if (firstLocation !== undefined) {
        const firstDeclaration =
          firstLocation.path === document.path
            ? `on line ${firstLocation.line}`
            : `in ${firstLocation.path} on line ${firstLocation.line}`;
        issues.push({
          path: document.path,
          line: lineNumber,
          message: `Task ID "${id}" is duplicated; it was first declared ${firstDeclaration}.`,
        });
      } else {
        firstLocationById.set(id, { path: document.path, line: lineNumber });
      }
    });
  }

  return issues;
}
