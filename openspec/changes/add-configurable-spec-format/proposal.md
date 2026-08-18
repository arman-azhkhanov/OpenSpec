## Why

A schema can describe *which* artifacts a workflow produces, but not *what shape* their content has. `ArtifactSchema` (`src/core/artifact-graph/types.ts`) is `{ id, generates, description, template, instruction, requires }` — no field says how a requirement or a scenario is written. The shapes themselves (`## Requirements`, `### Requirement: {name}`, `#### Scenario: {name}`, `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`, `SHALL`/`MUST`) live as literals and regexes in **12 files under `src/`** (excluding `src/core/templates/`; form: `rg -l -e '### Requirement:' -e '#### Scenario:' -e '## Requirements' -e '## (ADDED|MODIFIED|REMOVED|RENAMED)' src/ --glob '!src/core/templates/**'`, verified at `v1.9.0`).

Because the artifact zod object strips unknown keys, a schema author can already *write* a `format:` block today and get a green light with no effect: adding `format: {...}` plus a nonsense key to a forked schema's `specs` artifact still gives `✓ Schema 'probe-fmt' is valid` (RC=0), while a genuine defect in the same file — `requires: [no-such-artifact]` — is reported (RC=1). The silent-drop path is the surprising one, and it is what a schema author hits first.

This is the parser half of #666, scoped down. #829 proposes a `validation` block that configures *enforcement*; this proposes a `format` block that configures *recognition*. #1161 leaves the compatibility contract for custom schemas open. Concrete users blocked by recognition today:

- teams whose specs predate OpenSpec and use `## Functional Requirements` or a separate `verify.md` (#666's own examples);
- non-English projects: `openspec/specs/cli-validate/spec.md` already ships *"Normative keyword guidance SHALL not require English"*, but the escape is a permanent RFC 2119 warning that still fails `--strict`. A declared `normativeKeywords` makes the project's own keywords first-class instead (the ask behind PR #840);
- anyone whose existing corpus must be readable by `validate` *and* rewritable by `archive` — the one thing that cannot be handled by an external pre-processor, because archive rewrites the main spec through the internal format.

## What Changes

- **`schema.yaml`**: new **optional** `format` block on an artifact. Fields: `requirementsSection`, `requirementHeader`, `scenarioHeader`, `deltaSection`, `normativeKeywords`. Omit the block and nothing changes.
- **Bundled `spec-driven` schema**: declares today's literals explicitly as its own values, so the built-in schema is self-describing and the default path stays byte-identical.
- **Parsers / validator**: `spec-structure.ts`, `requirement-blocks.ts`, `change-parser.ts`, `requirement-text.ts`, `validator.ts` take the resolved format from the active schema instead of module-level literals. Resolution is a pure function of the artifact definition, so a caller that has no schema (legacy paths, direct file validation) gets the same defaults it has today.
- **Emission**: `specs-apply.ts` (delta merge, RENAMED header rewrite) and change/spec skeleton generation write through the *same* resolved format they read with, so `validate` and `archive` cannot disagree about shape.
- **No new commands, no new top-level config key, no format sniffing.** A project opts in by declaring the block in its own schema; nothing is inferred from file contents.

### Explicitly out of scope

- **Non-Markdown document models.** Replacing the underlying markup (Org, AsciiDoc, reStructuredText) is *not* proposed here and is not a schema field. This change only makes the Markdown token shapes declarable.
- **Multi-file spec collections** (`spec.md` + `verify.md`), the other half of #666 — separable, no dependency in either direction.
- **The `validation` block of #829** — enforcement, not recognition. The field shapes are deliberately parallel so `format` can nest under an artifact-level block later if #829 lands first.
- **Migrating `applySpecRules` / `applyChangeRules`** to be schema-driven.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `artifact-graph`: the artifact schema gains an optional `format` block; loading resolves it against built-in defaults and rejects an ill-formed block instead of dropping it.
- `cli-validate`: recognition of requirements, scenarios, delta sections, and normative keywords reads the resolved format for the change's schema; unchanged when no block is declared.

## Impact

- `src/core/artifact-graph/types.ts` — optional `format` field on `ArtifactSchema` with zod definitions.
- `src/core/artifact-graph/schema.ts` — resolve declared format against defaults at load time.
- `src/core/parsers/spec-structure.ts`, `requirement-blocks.ts`, `change-parser.ts`, `requirement-text.ts` — anchors built from the resolved format rather than module constants.
- `src/core/validation/validator.ts`, `src/core/validation/constants.ts` — validation and messages carry the declared tokens.
- `src/core/specs-apply.ts` — merge and RENAMED emission use the resolved format.
- `schemas/spec-driven/schema.yaml` — declares the current literals as defaults (behavioral no-op).
- Backward compatibility: every existing schema, spec, and change is unaffected — omitting `format` reproduces current behavior exactly. Existing tests that assert the built-in shapes stay green unchanged; new tests cover a schema that declares a non-default block.
- Related: #666 (parser configurability — this is its first half), #829 (validation block), #1161 (custom-schema compatibility contract), #840 (non-English normative keywords).
