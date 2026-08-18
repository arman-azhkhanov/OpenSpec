import { MarkdownParser, Section } from './markdown-parser.js';
import { buildStructureMask } from './code-fence.js';
import { defaultFormat, type ResolvedFormat } from './grammar.js';
import { Change, Delta, DeltaOperation, Requirement } from '../schemas/index.js';
import path from 'path';
import { promises as fs } from 'fs';
import { discoverSpecFiles } from '../../utils/spec-discovery.js';

interface DeltaSection {
  operation: DeltaOperation;
  requirements: Requirement[];
  renames?: Array<{ from: string; to: string }>;
}

export class ChangeParser extends MarkdownParser {
  private changeDir: string;

  /**
   * `format` is the resolved format of the change's proposal artifact. Callers
   * that have no schema in hand get the Markdown defaults, so their behavior is
   * unchanged; a caller that does hold the artifact must pass it, or this
   * reader looks for `## Why` in a document whose sections are `* Why`.
   */
  constructor(content: string, changeDir: string, format: ResolvedFormat = defaultFormat()) {
    super(content, format);
    this.changeDir = changeDir;
  }

  /** A delta section's parsed title (`ADDED Requirements`), in this format. */
  private deltaSectionTitle(operation: DeltaOperation): string {
    return this.sectionTitle(this.format.deltaSectionLine(operation));
  }

  async parseChangeWithDeltas(name: string): Promise<Change> {
    const sections = this.parseSections();
    const why = this.findSection(sections, 'Why')?.content || '';
    const whatChanges = this.findSection(sections, 'What Changes')?.content || '';
    
    if (!why) {
      throw new Error('Change must have a Why section');
    }
    
    if (!whatChanges) {
      throw new Error('Change must have a What Changes section');
    }

    // Parse deltas from the What Changes section (simple format)
    const simpleDeltas = this.parseDeltas(whatChanges);
    
    // Check if there are spec files with delta format
    const specsDir = path.join(this.changeDir, 'specs');
    const deltaDeltas = await this.parseDeltaSpecs(specsDir);
    
    // Combine both types of deltas, preferring delta format if available
    const deltas = deltaDeltas.length > 0 ? deltaDeltas : simpleDeltas;

    return {
      name,
      why: why.trim(),
      whatChanges: whatChanges.trim(),
      deltas,
      metadata: {
        version: '1.0.0',
        format: 'openspec-change',
      },
    };
  }

  private async parseDeltaSpecs(specsDir: string): Promise<Delta[]> {
    const deltas: Delta[] = [];

    // Discover delta specs recursively so nested layouts like
    // specs/<area>/<capability>/spec.md are parsed too (#1353)
    const specFiles = await discoverSpecFiles(specsDir, this.format);

    for (const { id, specFile } of specFiles) {
      try {
        const content = await fs.readFile(specFile, 'utf-8');
        const specDeltas = this.parseSpecDeltas(id, content);
        deltas.push(...specDeltas);
      } catch (error) {
        // Spec file might not be readable, which is okay
        continue;
      }
    }

    return deltas;
  }

  /**
   * Read requirements from a delta section, ignoring headers that are not
   * `### Requirement: <name>`.
   *
   * A delta section often carries divider headers such as
   * `### Documentation Requirements`. The base parser treats every child header
   * as a requirement, which invented a scenario-less requirement that does not
   * exist (#498): archive warned about a missing scenario, and `show --json`
   * reported an extra delta. The delta reader already skips these headers and
   * notes them, so this keeps the two readers in agreement.
   *
   * Overriding here rather than in MarkdownParser keeps main spec parsing —
   * `view`, `list`, `spec --json`, spec validation — untouched.
   *
   * What counts as a requirement header comes from the format, not from the
   * Markdown wording: the section titles it filters have already had their
   * heading marker stripped, so `REQUIREMENT_TITLE` is the judgement at that
   * level. For the built-in defaults it is the literal this filter carried.
   */
  protected parseRequirements(section: Section): Requirement[] {
    return super.parseRequirements({
      ...section,
      children: section.children.filter((child) =>
        this.format.REQUIREMENT_TITLE.test(child.title.trim())
      ),
    });
  }

  private parseSpecDeltas(specName: string, content: string): Delta[] {
    const deltas: Delta[] = [];
    const sections = this.parseSectionsFromContent(content);
    
    // Parse ADDED requirements
    const addedSection = this.findSection(sections, this.deltaSectionTitle('ADDED'));
    if (addedSection) {
      const requirements = this.parseRequirements(addedSection);
      requirements.forEach(req => {
        deltas.push({
          spec: specName,
          operation: 'ADDED' as DeltaOperation,
          description: `Add requirement: ${req.text}`,
          // Provide both single and plural forms for compatibility
          requirement: req,
          requirements: [req],
        });
      });
    }
    
    // Parse MODIFIED requirements
    const modifiedSection = this.findSection(sections, this.deltaSectionTitle('MODIFIED'));
    if (modifiedSection) {
      const requirements = this.parseRequirements(modifiedSection);
      requirements.forEach(req => {
        deltas.push({
          spec: specName,
          operation: 'MODIFIED' as DeltaOperation,
          description: `Modify requirement: ${req.text}`,
          requirement: req,
          requirements: [req],
        });
      });
    }
    
    // Parse REMOVED requirements
    const removedSection = this.findSection(sections, this.deltaSectionTitle('REMOVED'));
    if (removedSection) {
      const requirements = this.parseRequirements(removedSection);
      requirements.forEach(req => {
        deltas.push({
          spec: specName,
          operation: 'REMOVED' as DeltaOperation,
          description: `Remove requirement: ${req.text}`,
          requirement: req,
          requirements: [req],
        });
      });
    }
    
    // Parse RENAMED requirements
    const renamedSection = this.findSection(sections, this.deltaSectionTitle('RENAMED'));
    if (renamedSection) {
      const renames = this.parseRenames(renamedSection.content);
      renames.forEach(rename => {
        deltas.push({
          spec: specName,
          operation: 'RENAMED' as DeltaOperation,
          description: `Rename requirement from "${rename.from}" to "${rename.to}"`,
          rename,
        });
      });
    }
    
    return deltas;
  }

  private parseRenames(content: string): Array<{ from: string; to: string }> {
    const renames: Array<{ from: string; to: string }> = [];
    const lines = ChangeParser.normalizeContent(content).split('\n');
    
    let currentRename: { from?: string; to?: string } = {};
    
    for (const line of lines) {
      const fromMatch = line.match(this.format.RENAME_FROM);
      const toMatch = line.match(this.format.RENAME_TO);
      
      if (fromMatch) {
        currentRename.from = fromMatch[1].trim();
      } else if (toMatch) {
        currentRename.to = toMatch[1].trim();
        
        if (currentRename.from && currentRename.to) {
          renames.push({
            from: currentRename.from,
            to: currentRename.to,
          });
          currentRename = {};
        }
      }
    }
    
    return renames;
  }

  /**
   * Parse a delta spec file's sections. Same walk as the base parser, over
   * arbitrary content rather than this instance's own, and through the same
   * resolved format: the structure mask, the heading shape and the depth
   * numbering are all the format's, so an Org delta file is read as Org.
   */
  private parseSectionsFromContent(content: string): Section[] {
    const normalizedContent = ChangeParser.normalizeContent(content);
    const lines = normalizedContent.split('\n');
    const codeFenceLineMask = buildStructureMask(lines, this.format);
    const sections: Section[] = [];
    const stack: Section[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (codeFenceLineMask[i]) {
        continue;
      }
      const headerMatch = line.match(this.format.HEADING_ANY);

      if (headerMatch) {
        const level = this.format.headingLevel(line)!;
        const title = headerMatch[2].trim();
        const contentLines = this.getContentUntilNextHeaderFromLines(lines, codeFenceLineMask, i + 1, level);
        
        const section = {
          level,
          title,
          content: contentLines.join('\n').trim(),
          children: [],
        };

        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }

        if (stack.length === 0) {
          sections.push(section);
        } else {
          stack[stack.length - 1].children.push(section);
        }
        
        stack.push(section);
      }
    }
    
    return sections;
  }

  private getContentUntilNextHeaderFromLines(
    lines: string[],
    codeFenceLineMask: boolean[],
    startLine: number,
    currentLevel: number
  ): string[] {
    const contentLines: string[] = [];
    
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      const level = codeFenceLineMask[i] ? null : this.format.headingLevel(line);

      if (level !== null && level <= currentLevel) {
        break;
      }

      contentLines.push(line);
    }
    
    return contentLines;
  }
}
