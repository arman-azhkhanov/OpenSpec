/**
 * Shared fenced-block detection for the spec parsers.
 *
 * Several parsers need to ignore structure (headers, requirement blocks,
 * scenarios, delta sections) that appears inside a fenced block. Keeping this
 * logic in one place avoids the drift that previously left
 * `requirement-blocks.ts` treating fenced `### Requirement:` lines as real
 * requirements during validation and archiving.
 *
 * What opens and closes a fence, and whether a fence hides structure at all,
 * are properties of the resolved format rather than literals here: Markdown
 * fences with a backtick or tilde run and a fenced heading is invisible, while
 * Org fences with `#+begin_`/`#+end_` and a heading inside one is still a
 * heading (an example heading is escaped in the body instead). Callers that
 * pass no format get the Markdown defaults, so their behavior is unchanged.
 */

import { defaultFormat, type ResolvedFormat } from './grammar.js';

interface ActiveFence {
  /** Group 1 of the opener: the run of fence characters, or the block name. */
  id: string;
}

function openingFence(line: string, format: ResolvedFormat): ActiveFence | null {
  const match = line.match(format.FENCE_OPEN);
  return match ? { id: match[1] } : null;
}

/**
 * Whether a closer ends the fence that is open.
 *
 * FORK-ONLY branch: the two families disagree about what "the same fence"
 * means, and no single comparison covers both. Markdown matches on the fence
 * character with a run at least as long as the opener's (CommonMark), while Org
 * matches the block name exactly — comparing Org names by first character and
 * length would let `#+end_example` close `#+begin_export`.
 */
function closesFence(line: string, active: ActiveFence, format: ResolvedFormat): boolean {
  const match = line.match(format.FENCE_CLOSE);
  if (!match) {
    return false;
  }
  const id = match[1];
  if (format.markup === 'org') {
    return id.toLowerCase() === active.id.toLowerCase();
  }
  return id[0] === active.id[0] && id.length >= active.id.length;
}

/**
 * Builds a per-line mask where `true` marks a line that is part of a fenced
 * block (including the opening and closing fence lines themselves).
 */
export function buildCodeFenceMask(
  lines: string[],
  format: ResolvedFormat = defaultFormat()
): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let activeFence: ActiveFence | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (!activeFence) {
      const fence = openingFence(lines[i], format);
      if (fence) {
        activeFence = fence;
        mask[i] = true;
      }
      continue;
    }

    mask[i] = true;
    if (closesFence(lines[i], activeFence, format)) {
      activeFence = null;
    }
  }

  return mask;
}

/**
 * The mask the structure readers consult: lines whose structure must be
 * ignored because a fence hides it.
 *
 * Identical to `buildCodeFenceMask` in Markdown. In Org it is all `false`,
 * because a line of stars is a heading wherever it sits — including inside
 * `#+begin_src` — so a reader that skipped fenced lines would drop real
 * requirements. An example heading that must NOT read as structure is escaped
 * in the body with Org's own `,*` convention, written by the author of the
 * block, rather than hidden by the fence.
 */
export function buildStructureMask(
  lines: string[],
  format: ResolvedFormat = defaultFormat()
): boolean[] {
  if (!format.fenceMasksHeadings) {
    return new Array<boolean>(lines.length).fill(false);
  }
  return buildCodeFenceMask(lines, format);
}
