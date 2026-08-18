/**
 * Validation threshold constants and message text.
 *
 * Messages that quote the shape of a spec — headers, delta sections, scenario
 * blocks — are built from the resolved format (`buildGuidance`) rather than
 * written out, so remediation advice tells an author about the markup their own
 * artifact is written in. With the default format every string below renders
 * exactly as it was written before, which is what keeps existing output stable.
 */

import {
  defaultFormat,
  deltaHeaders as formatDeltaHeaders,
  scenarioLabel as formatScenarioLabel,
  type ResolvedFormat,
} from '../parsers/grammar.js';

// Minimum character lengths
export const MIN_WHY_SECTION_LENGTH = 50;
export const MIN_PURPOSE_LENGTH = 50;

// Maximum character/item limits
export const MAX_WHY_SECTION_LENGTH = 1000;
export const MAX_REQUIREMENT_TEXT_LENGTH = 500;
export const MAX_DELTAS_PER_CHANGE = 10;

// Validation messages
export const VALIDATION_MESSAGES = {
  // Required content
  SCENARIO_EMPTY: 'Scenario text cannot be empty',
  REQUIREMENT_EMPTY: 'Requirement text cannot be empty',
  REQUIREMENT_NO_SHALL: 'Requirement must contain SHALL or MUST keyword',
  REQUIREMENT_NO_SCENARIOS: 'Requirement must have at least one scenario',
  SPEC_NAME_EMPTY: 'Spec name cannot be empty',
  SPEC_PURPOSE_EMPTY: 'Purpose section cannot be empty',
  SPEC_NO_REQUIREMENTS: 'Spec must have at least one requirement',
  CHANGE_NAME_EMPTY: 'Change name cannot be empty',
  CHANGE_WHY_TOO_SHORT: `Why section must be at least ${MIN_WHY_SECTION_LENGTH} characters`,
  CHANGE_WHY_TOO_LONG: `Why section should not exceed ${MAX_WHY_SECTION_LENGTH} characters`,
  CHANGE_WHAT_EMPTY: 'What Changes section cannot be empty',
  CHANGE_NO_DELTAS: 'Change must have at least one delta',
  CHANGE_SKIP_SPECS_CONFLICT:
    'skip_specs is set in .openspec.yaml but spec files exist under specs/. Remove skip_specs or delete the delta spec files',
  CHANGE_SKIP_SPECS_ACCEPTED:
    'skip_specs is set in .openspec.yaml: change declares no spec-level behavior changes, zero deltas accepted',
  CHANGE_SKIP_SPECS_INVALID_METADATA:
    'skip_specs is set but .openspec.yaml is not valid change metadata, so the marker is not honored. Fix the metadata',
  CHANGE_TOO_MANY_DELTAS: `Consider splitting changes with more than ${MAX_DELTAS_PER_CHANGE} deltas`,
  DELTA_SPEC_EMPTY: 'Spec name cannot be empty',
  DELTA_DESCRIPTION_EMPTY: 'Delta description cannot be empty',
  
  // Warnings
  PURPOSE_TOO_BRIEF: `Purpose section is too brief (less than ${MIN_PURPOSE_LENGTH} characters)`,
  REQUIREMENT_TOO_LONG: `Requirement text is very long (>${MAX_REQUIREMENT_TEXT_LENGTH} characters). Consider breaking it down.`,
  DELTA_DESCRIPTION_TOO_BRIEF: 'Delta description is too brief',
  DELTA_MISSING_REQUIREMENTS: 'Delta should include requirements',
} as const;

/**
 * Guidance snippets appended to primary messages for remediation. Every token
 * they quote is rendered from the format, so an author reading them is shown
 * the markup they are actually writing in.
 */
export interface ValidationGuidance {
  NO_DELTAS: string;
  MISSING_SPEC_SECTIONS: string;
  MISSING_CHANGE_SECTIONS: string;
  SCENARIO_FORMAT: string;
}

/** A top-level section heading for a title the format has no token for. */
function sectionHeading(format: ResolvedFormat, title: string): string {
  const line = format.requirementsSectionLine();
  const body = line.replace(format.HEADING_PREFIX, '');
  return line.slice(0, line.length - body.length) + title;
}

/**
 * FORK-ONLY. Emphasis around a keyword. No token template can express it, and
 * the two families spell it differently (`**WHEN**` / `*WHEN*`).
 */
function bold(format: ResolvedFormat, text: string): string {
  return format.markup === 'org' ? `*${text}*` : `**${text}**`;
}

export function buildGuidance(format: ResolvedFormat = defaultFormat()): ValidationGuidance {
  const specFile = format.SPEC_FILE;
  const specExtension = specFile.slice(specFile.lastIndexOf('.'));
  // Both come from the grammar's own single copy, the same one the `validate`
  // and `change` footers render: this guidance and those footers name the very
  // same headers, and a project reading one after the other must not be told
  // two different things.
  const deltaHeaders = formatDeltaHeaders(format);
  const scenarioLabel = formatScenarioLabel(format);
  const keyword = format.NORMATIVE_KEYWORDS[0];
  const whenThen = `- ${bold(format, 'WHEN')} ...\n- ${bold(format, 'THEN')} ...`;

  return {
    NO_DELTAS:
      `No deltas found. Ensure your change has a specs/ directory with capability folders ` +
      `(e.g. specs/http-server/${specFile}) containing ${specExtension} files that use delta headers ` +
      `(${deltaHeaders}) and that each requirement includes at least one "${scenarioLabel}" block. ` +
      `If this change intentionally modifies no specs (pure refactor, tooling, docs), set ` +
      `"skip_specs: true" in the change's .openspec.yaml instead. Tip: run ` +
      `"openspec change show <change-id> --json --deltas-only" to inspect parsed deltas.`,
    MISSING_SPEC_SECTIONS:
      `Missing required sections. Expected headers: "${format.purposeSectionLine()}" and ` +
      `"${format.requirementsSectionLine()}". Example:\n${format.purposeSectionLine()}\n` +
      `[brief purpose]\n\n${format.requirementsSectionLine()}\n` +
      `${format.requirementHeaderLine('Clear requirement statement')}\n` +
      `Users ${keyword} ...\n\n${format.scenarioHeaderLine('Descriptive name')}\n${whenThen}`,
    MISSING_CHANGE_SECTIONS:
      `Missing required sections. Expected headers: "${sectionHeading(format, 'Why')}" and ` +
      `"${sectionHeading(format, 'What Changes')}". Ensure deltas are documented in specs/ ` +
      `using delta headers.`,
    // "level-4" is Markdown numbering on purpose: section depth is Markdown-
    // numbered throughout this codebase (see `Section.level`). The line that
    // follows shows the author the token their own format uses.
    SCENARIO_FORMAT:
      `Scenarios must use level-4 headers. Convert bullet lists into:\n` +
      `${format.scenarioHeaderLine('Short name')}\n${whenThen}\n- ${bold(format, 'AND')} ...`,
  };
}
