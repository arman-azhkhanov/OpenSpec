## ADDED Requirements

### Requirement: Recognition SHALL use the format declared by the active schema
Requirement headers, scenario headers, the requirements section, and delta operation sections SHALL be recognized using the format resolved from the artifact definition of the schema that owns the item being validated. A change SHALL resolve its schema from the change's own `.openspec.yaml`; a main spec SHALL resolve it from the schema whose artifact `generates` glob matches the spec file. When no schema is available to a call site, recognition SHALL fall back to the built-in defaults, so that direct file validation behaves as it does today.

#### Scenario: Declared requirement header is recognized
- **GIVEN** a schema whose spec artifact declares a `requirementHeader` other than the built-in one
- **WHEN** running `openspec validate` on a change written in that shape
- **THEN** the requirements SHALL be recognized and validation SHALL report the same issues it would report for the equivalent default-shaped content

#### Scenario: Built-in shape is unaffected
- **GIVEN** a project that declares no `format` block
- **WHEN** running `openspec validate` on any existing change or spec
- **THEN** the result, the issue list, and the exit code SHALL be unchanged from before this change

#### Scenario: Content does not match the declared shape
- **GIVEN** a schema declaring a non-default `requirementHeader` and a spec written in the built-in shape
- **WHEN** running `openspec validate` on that spec
- **THEN** validation SHALL report that no requirement matching the declared header was found, and the message SHALL quote the declared token

### Requirement: Normative keyword detection SHALL follow the declared keywords
Normative-keyword detection SHALL use the keywords declared by the active artifact's `format.normativeKeywords`, defaulting to `SHALL` and `MUST` when undeclared. Declared keywords SHALL be matched as whole words. A requirement body containing a declared keyword SHALL NOT produce the RFC 2119 guidance warning, and SHALL therefore pass `--strict` on that ground alone; a body containing none of the declared keywords SHALL produce the existing warning with its existing severity.

#### Scenario: Project declares its own normative keywords
- **GIVEN** a schema declaring `normativeKeywords` appropriate to the project's working language
- **WHEN** running `openspec validate --strict` on a requirement whose body uses one of those keywords
- **THEN** no RFC 2119 guidance warning SHALL be reported and validation SHALL succeed

#### Scenario: Default keywords when undeclared
- **WHEN** no `normativeKeywords` value is declared
- **THEN** detection SHALL match `SHALL` and `MUST` as whole words, exactly as before this change

### Requirement: Emission SHALL use the same resolved format as recognition
Content written by the tool — delta skeletons, the merged main spec produced by archive, and RENAMED header rewrites — SHALL be emitted using the same resolved format that recognition used for the same artifact. A round trip of archive followed by validate SHALL therefore not report shape errors on content the tool itself wrote.

#### Scenario: Archive round trip under a declared format
- **GIVEN** a change validated under a schema declaring a non-default `requirementHeader`
- **WHEN** the change is archived and the resulting main spec is validated
- **THEN** the merged spec SHALL be written in the declared shape and SHALL validate without shape errors

#### Scenario: Renamed requirement is emitted in the declared shape
- **GIVEN** a delta containing a RENAMED requirement under a schema declaring a non-default `requirementHeader`
- **WHEN** the change is archived
- **THEN** the rewritten header in the main spec SHALL use the declared shape, not the built-in literal
