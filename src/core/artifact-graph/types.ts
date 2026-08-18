import * as path from 'node:path';
import { z } from 'zod';

function relativePathSchema(fieldName: string) {
  return z
    .string()
    .min(1, { error: `${fieldName} is required` })
    .superRefine((value, ctx) => {
      const segments = value.split(/[\\/]+/u);
      const isDrivePath = /^[A-Za-z]:/u.test(value);
      const isAbsolute =
        path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || isDrivePath;
      const escapes = segments.includes('..');

      if (isAbsolute || escapes || value.includes('\0')) {
        ctx.addIssue({
          code: 'custom',
          message: `${fieldName} must be a relative path inside its allowed directory`,
        });
      }
    });
}

/**
 * Per-artifact declaration of the token shapes its content is written in.
 *
 * Optional at every level: an artifact without the block, and a schema whose
 * artifacts all omit it, resolve to the built-in defaults
 * (`resolveFormat` in src/core/parsers/grammar.ts), which reproduce the
 * literals the parsers carried before this field existed.
 *
 * The object is STRICT on purpose. An unknown key inside the block is reported
 * rather than stripped, because a silently discarded declaration is
 * indistinguishable to the author from one that took effect — which is the
 * behavior this field is here to end.
 */
export const ArtifactFormatSchema = z.strictObject({
  // Declarable token shapes. `{name}` / `{operation}` mark the captured part;
  // the loader compiles them, so a schema never supplies a regex.
  requirementsSection: z.string().optional(),
  requirementHeader: z.string().optional(),
  scenarioHeader: z.string().optional(),
  deltaSection: z.string().optional(),
  normativeKeywords: z.array(z.string()).optional(),
  // FORK-ONLY beyond this line: the markup family selects the shapes no token
  // template can express (heading marker, fence syntax, bullet and checkbox
  // classes, property drawers, body escaping). Registered here so a schema
  // declaring it is not rejected by this object's own strictness.
  markup: z.enum(['markdown', 'org']).optional(),
});

// Artifact definition schema
export const ArtifactSchema = z.object({
  id: z.string().min(1, { error: 'Artifact ID is required' }),
  generates: relativePathSchema('generates field'),
  description: z.string(),
  template: relativePathSchema('template field'),
  instruction: z.string().optional(),
  requires: z.array(z.string()).default([]),
  format: ArtifactFormatSchema.optional(),
});

// Apply phase configuration for schema-aware apply instructions
export const ApplyPhaseSchema = z.object({
  // Artifact IDs that must exist before apply is available
  requires: z.array(z.string()).min(1, { error: 'At least one required artifact' }),
  // Path to file with checkboxes for progress (relative to change dir), or null if no tracking
  tracks: relativePathSchema('apply.tracks').nullable().optional(),
  // Custom guidance for the apply phase
  instruction: z.string().optional(),
});

// Full schema YAML structure
export const SchemaYamlSchema = z.object({
  name: z.string().min(1, { error: 'Schema name is required' }),
  version: z.number().int().positive({ error: 'Version must be a positive integer' }),
  description: z.string().optional(),
  artifacts: z.array(ArtifactSchema).min(1, { error: 'At least one artifact required' }),
  // Optional apply phase configuration (for schema-aware apply instructions)
  apply: ApplyPhaseSchema.optional(),
});

// Derived TypeScript types
export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ApplyPhase = z.infer<typeof ApplyPhaseSchema>;
export type SchemaYaml = z.infer<typeof SchemaYamlSchema>;

// Runtime state types (not Zod - internal only)

// Slice 1: Simple completion tracking via filesystem
export type CompletedSet = Set<string>;

// Return type for blocked query
export interface BlockedArtifacts {
  [artifactId: string]: string[];
}
