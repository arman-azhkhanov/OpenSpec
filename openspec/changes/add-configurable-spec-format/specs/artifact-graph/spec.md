## ADDED Requirements

### Requirement: Artifacts SHALL be able to declare their content format
An artifact entry in `schema.yaml` SHALL accept an optional `format` block declaring the token shapes used to recognize and emit its content: `requirementsSection`, `requirementHeader`, `scenarioHeader`, `deltaSection`, and `normativeKeywords`. The block SHALL be optional at every level: an artifact without it, and a schema whose artifacts all omit it, SHALL resolve to the built-in defaults that reproduce current behavior exactly. Schema loading SHALL expose the resolved format alongside the artifact definition so that readers and writers consume one resolved value rather than module-level literals.

#### Scenario: Schema declares no format block
- **WHEN** a schema is loaded whose artifacts declare no `format` block
- **THEN** every artifact resolves to the built-in default tokens and downstream parsing behavior is identical to the behavior before this change

#### Scenario: Schema declares a partial format block
- **GIVEN** an artifact that declares only `normativeKeywords`
- **WHEN** the schema is loaded
- **THEN** the declared field takes effect and every field not declared resolves to its built-in default

#### Scenario: Two artifacts declare different formats
- **GIVEN** a schema with two artifacts that each declare a different `requirementHeader`
- **WHEN** the schema is loaded
- **THEN** each artifact resolves to its own declared format and neither overrides the other

### Requirement: An ill-formed format declaration SHALL be rejected, not dropped
Schema loading SHALL reject a `format` block that cannot be honored, and `openspec schema validate` SHALL report the error with the offending artifact id and field name. A header token that omits the `{name}` placeholder, an empty `normativeKeywords` value, and a declared token identical to another declared token in the same artifact SHALL each be errors. Unknown keys inside a `format` block SHALL be reported rather than silently discarded, because a silently discarded declaration is indistinguishable to the author from a declaration that took effect.

#### Scenario: Header token missing its placeholder
- **WHEN** an artifact declares `requirementHeader` with no `{name}` placeholder
- **THEN** `openspec schema validate` reports an error naming the artifact and the field, and exits non-zero

#### Scenario: Unknown key inside the format block
- **WHEN** an artifact declares a `format` block containing a key that is not part of the block
- **THEN** `openspec schema validate` reports the unrecognized key rather than accepting the schema as valid

#### Scenario: Colliding tokens in one artifact
- **WHEN** an artifact declares `requirementHeader` and `scenarioHeader` with the same token shape
- **THEN** `openspec schema validate` reports the collision, because the reader could not tell the two apart
