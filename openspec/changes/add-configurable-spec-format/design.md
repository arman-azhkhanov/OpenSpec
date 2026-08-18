## Context

See `proposal.md` — Why. The relevant current state, verified at `v1.9.0`:

- `ArtifactSchema` is a zod object with six fields and no content-shape field; zod strips unknown keys, so an artifact-level `format:` block is accepted and dropped without a diagnostic.
- Recognition anchors are module-level literals: `spec-structure.ts` (`/^##\s+Requirements\s*$/i`, `/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i`, `/^###\s+Requirement:\s*(.+)\s*$/i`), `requirement-blocks.ts` (`/^###\s*Requirement:\s*(.+)\s*$/i`), `change-parser.ts` (`FROM:`/`TO:` rename forms), `requirement-text.ts` (`containsShallOrMust` = `/\b(SHALL|MUST)\b/`).
- Emission anchors are separate literals in `specs-apply.ts` (e.g. the RENAMED rewrite builds `### Requirement: ${to}` as a template string).
- `fix-spec-parser-fidelity` recently collapsed the two *readers* into one shared extraction. This change keeps that single reader and makes its anchors parameters.

## Goals / Non-Goals

**Goals**

- One optional, explicit, per-artifact declaration of the token shapes the reader and the writer both use.
- Zero behavior change for any project that does not declare it.
- A wrong declaration fails loudly at schema-load time, not silently at parse time.

**Non-Goals**

- Changing the internal document model. The canonical representation stays as it is; only the surface tokens become declarable.
- Auto-detecting a project's format. Detection is exactly the implicit routing that was rejected in favor of explicit per-change opt-in; this change is explicit-only.
- Supporting a markup family other than Markdown.
- Configuring enforcement thresholds (`MIN_PURPOSE_LENGTH`, required sections) — that is #829.

## Decisions

**D1. A `format` block on the artifact, not a top-level schema key.**
Alternative considered: a schema-level `specFormat:`. Rejected because a schema may define more than one artifact with block structure (`spec.md` today, a `verify.md` later — #666's multi-file case), and a per-artifact block scales to that without a second mechanism. It also matches where #829 puts `validation`, so the two can nest under one artifact-level block if that is preferred.

**D2. Declared tokens, not raw regexes.**
The block takes token templates (`### Requirement: {name}`) rather than user-supplied regexes. Reasons: a regex in a schema is an injection and a performance surface; token templates can be validated at load time; and the same declaration is reusable for *emission*, which a regex is not. `normativeKeywords` is the one exception in spirit — an alternation of literal keywords, compiled with word boundaries by the loader, never interpolated raw.

**D3. Resolution is a pure function with the current literals as defaults.**
`resolveFormat(artifact?) -> ResolvedFormat` returns today's values when the artifact is absent or declares no block. Every call site that has no schema in hand (direct file validation, legacy code paths) therefore behaves exactly as it does now, and no call site needs a nullable format.

**D4. One resolved format for read and write.**
`specs-apply.ts` emission takes the same `ResolvedFormat` the reader used. This is the invariant that keeps `validate` and `archive` from disagreeing — the failure mode `fix-spec-parser-fidelity` was written to prevent, one layer up.

**D5. An ill-formed block is an error at load.**
A `requirementHeader` without a `{name}` placeholder, an empty `normativeKeywords`, or a declared token that collides with another declared token is rejected by `openspec schema validate` with the artifact id in the message. Today the same input is silently dropped; the loud version is the point of the change.

## Risks / Trade-offs

- **Two schemas in one repo declaring different formats** → the format is resolved per change, from the schema that change records in its `.openspec.yaml`; main-spec reads resolve from the schema that owns the capability's `generates` glob. Cross-schema archive merges are already outside the supported set and stay so.
- **A project declares a format, then removes the block** → previously-archived specs keep their written shape and stop parsing. Mitigation: `openspec validate --specs` reports the mismatch with the expected token, rather than reporting "no requirements found".
- **Surface growth** → five optional fields on one existing type, no new command, no new top-level key, no new file. The bundled schema gets longer by declaring what is currently implicit; that is a readability gain rather than a new concept.
- **Test-suite churn** → recognition is unchanged for the built-in schema, so existing assertions stay green as written; the new tests are additive and pin a non-default declaration.

## Migration Plan

1. Ship the block as optional with defaults equal to the current literals — no user action, no migration.
2. Declare the literals in `schemas/spec-driven/schema.yaml` in the same release; a diff of parser behavior before/after must be empty.
3. Nothing to roll back beyond reverting the field: absent the block, every path resolves to the same defaults.

## Open Questions

- Whether `format` should be a sibling of #829's `validation` or nest inside it. Deferring is safe: the block is optional in both shapes and the answer does not change the parser work or the task breakdown.
- Whether `normativeKeywords` should also relax the RFC 2119 *guidance warning* text, or only the predicate. Cosmetic, resolvable at implementation time.
