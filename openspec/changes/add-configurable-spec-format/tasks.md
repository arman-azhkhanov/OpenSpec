## 1. Schema surface

- [ ] 1.1 Add an optional `format` object to `ArtifactSchema` in `src/core/artifact-graph/types.ts` with zod definitions for `requirementsSection`, `requirementHeader`, `scenarioHeader`, `deltaSection`, `normativeKeywords`; make the object strict so unknown keys are reported instead of stripped.
- [ ] 1.2 Add `resolveFormat(artifact?)` returning a `ResolvedFormat` whose defaults are the current literals from `src/core/parsers/spec-structure.ts` and `requirement-text.ts`.
- [ ] 1.3 Validate the declaration at load: `{name}` placeholder required in header tokens, non-empty `normativeKeywords`, no two declared tokens identical within one artifact; error messages name artifact id and field.
- [ ] 1.4 Surface the resolved format from schema loading (`src/core/artifact-graph/schema.ts`) so consumers take one value.

## 2. Recognition

- [ ] 2.1 Build the section/header anchors in `src/core/parsers/spec-structure.ts` from a `ResolvedFormat` instead of module-level regex constants.
- [ ] 2.2 Do the same for `src/core/parsers/requirement-blocks.ts` (requirement block boundaries) and `src/core/parsers/change-parser.ts` (delta sections, `FROM:`/`TO:` rename forms).
- [ ] 2.3 Make `containsShallOrMust` in `src/core/parsers/requirement-text.ts` take the declared keywords, compiled with word boundaries from literal keywords (never interpolating a user-supplied regex).
- [ ] 2.4 Thread the resolved format into `src/core/validation/validator.ts` and quote declared tokens in `src/core/validation/constants.ts` messages.
- [ ] 2.5 Resolve the format per item in `src/commands/validate.ts`: a change from its `.openspec.yaml` schema, a main spec from the schema whose artifact `generates` glob matches it; fall back to defaults when no schema is available.

## 3. Emission

- [ ] 3.1 Take the resolved format in `src/core/specs-apply.ts` for delta merge and the RENAMED header rewrite.
- [ ] 3.2 Use the resolved format for generated skeletons and for the format hints printed by `src/commands/change.ts` and `src/commands/schema.ts`.

## 4. Bundled schema

- [ ] 4.1 Declare the current literals explicitly in `schemas/spec-driven/schema.yaml` so the built-in schema is self-describing.
- [ ] 4.2 Confirm the declaration is a behavioral no-op: parser and validator output identical before/after on the repository's own `openspec/` corpus.

## 5. Tests

- [ ] 5.1 Guard: the full existing suite passes unchanged, with no assertion edited — recognition for the built-in schema is not changed by this work.
- [ ] 5.2 A schema declaring a non-default `requirementHeader` parses, validates, and archives content written in that shape.
- [ ] 5.3 A schema declaring `normativeKeywords` suppresses the RFC 2119 guidance warning for its own keywords and still emits it for a body with none.
- [ ] 5.4 Must-redden: an ill-formed `format` block (missing `{name}`, empty keywords, colliding tokens, unknown key) fails `openspec schema validate` with a non-zero exit and names the artifact.
- [ ] 5.5 Round trip: archive under a declared format writes the declared shape, and validating the merged main spec reports no shape errors.
- [ ] 5.6 Fallback: validating a file with no resolvable schema uses the built-in defaults.

## 6. Documentation

- [ ] 6.1 Document the `format` block in the schema reference, stating that omitting it is the default and supported path.
- [ ] 6.2 Note the relationship to #829 (`validation` = enforcement, `format` = recognition) so schema authors are not left choosing between two mechanisms.
