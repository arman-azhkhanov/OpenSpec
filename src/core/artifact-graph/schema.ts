import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { collectFormatIssues } from '../parsers/grammar.js';
import { SchemaYamlSchema, type SchemaYaml, type Artifact } from './types.js';

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Loads and validates an artifact schema from a YAML file.
 */
export function loadSchema(filePath: string): SchemaYaml {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSchema(content);
}

/**
 * Parses and validates an artifact schema from YAML content.
 */
export function parseSchema(yamlContent: string): SchemaYaml {
  const parsed = parseYaml(yamlContent);

  // Validate with Zod
  const result = SchemaYamlSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map(e => `${e.path.join('.')}: ${e.message}${describeFormatArtifact(parsed, e.path)}`)
      .join(', ');
    throw new SchemaValidationError(`Invalid schema: ${errors}`);
  }

  const schema = result.data;

  // Check for duplicate artifact IDs
  validateNoDuplicateIds(schema.artifacts);

  // Check that all requires references are valid
  validateRequiresReferences(schema.artifacts);

  // Check for cycles
  validateNoCycles(schema.artifacts);

  // Check that every declared format block can be honored
  validateFormatDeclarations(schema.artifacts);

  return schema;
}

/**
 * Names the artifact behind a `format` block issue. Zod reports the block by
 * position, and a schema author needs the id. Only format paths are annotated,
 * so every other message reads exactly as it did.
 */
function describeFormatArtifact(parsed: unknown, path: ReadonlyArray<PropertyKey>): string {
  if (path[0] !== 'artifacts' || typeof path[1] !== 'number' || path[2] !== 'format') {
    return '';
  }

  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts)) {
    return '';
  }

  const id = (artifacts[path[1]] as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? ` (artifact '${id}')` : '';
}

/**
 * Validates the declared `format` blocks. A block that cannot be honored is an
 * error here rather than a silent drop at parse time: the author of a dropped
 * declaration cannot tell it from one that took effect.
 */
function validateFormatDeclarations(artifacts: Artifact[]): void {
  const issues = artifacts.flatMap(artifact => collectFormatIssues(artifact));
  if (issues.length > 0) {
    throw new SchemaValidationError(`Invalid format declaration: ${issues.join('; ')}`);
  }
}

/**
 * Validates that there are no duplicate artifact IDs.
 */
function validateNoDuplicateIds(artifacts: Artifact[]): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) {
      throw new SchemaValidationError(`Duplicate artifact ID: ${artifact.id}`);
    }
    seen.add(artifact.id);
  }
}

/**
 * Validates that all `requires` references point to valid artifact IDs.
 */
function validateRequiresReferences(artifacts: Artifact[]): void {
  const validIds = new Set(artifacts.map(a => a.id));

  for (const artifact of artifacts) {
    for (const req of artifact.requires) {
      if (!validIds.has(req)) {
        throw new SchemaValidationError(
          `Invalid dependency reference in artifact '${artifact.id}': '${req}' does not exist`
        );
      }
    }
  }
}

/**
 * Validates that there are no cyclic dependencies.
 * Uses DFS to detect cycles and reports the full cycle path.
 */
function validateNoCycles(artifacts: Artifact[]): void {
  const artifactMap = new Map(artifacts.map(a => [a.id, a]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  function dfs(id: string): string | null {
    visited.add(id);
    inStack.add(id);

    const artifact = artifactMap.get(id);
    if (!artifact) return null;

    for (const dep of artifact.requires) {
      if (!visited.has(dep)) {
        parent.set(dep, id);
        const cycle = dfs(dep);
        if (cycle) return cycle;
      } else if (inStack.has(dep)) {
        // Found a cycle - reconstruct the path
        const cyclePath = [dep];
        let current = id;
        while (current !== dep) {
          cyclePath.unshift(current);
          current = parent.get(current)!;
        }
        cyclePath.unshift(dep);
        return cyclePath.join(' → ');
      }
    }

    inStack.delete(id);
    return null;
  }

  for (const artifact of artifacts) {
    if (!visited.has(artifact.id)) {
      const cycle = dfs(artifact.id);
      if (cycle) {
        throw new SchemaValidationError(`Cyclic dependency detected: ${cycle}`);
      }
    }
  }
}
