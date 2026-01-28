import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  extractConceptsFromTextNormalized,
  getRepoNames,
  loadConceptConfig,
  normalizeConceptConfig,
  normalizeConceptToken,
  scanWorkspaceForMarkdown,
  splitIntoParagraphs,
} from './concepts.js';
import { getRelativePath } from './path-utils.js';

export type ConceptMention = {
  file: string;
  count: number;
};

export type ConceptEntry = {
  mentions: ConceptMention[];
  related: Record<string, number>;
  aliases?: string[];
};

export type ConceptsIndex = {
  concepts: Record<string, ConceptEntry>;
  files: Record<string, { concepts: string[] }>;
};

export class ConceptsIndexManager {
  private indexPath: string;
  private workspaceDir: string;
  private configDir: string;

  constructor(workspaceDir: string, configDir?: string) {
    this.workspaceDir = workspaceDir;
    this.configDir = configDir ?? join(homedir(), '.config', 'tg-gateway');
    this.indexPath = join(this.configDir, 'concepts-index.json');
  }

  getIndexPath(): string {
    return this.indexPath;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  async buildIndex(): Promise<ConceptsIndex> {
    const config = await loadConceptConfig(this.configDir);
    const normalizedConfig = normalizeConceptConfig(config);
    const repoNames = await getRepoNames(this.workspaceDir);
    const extraTerms = Array.from(new Set([...(config.allow ?? []), ...repoNames]));
    const normalizedExtraTerms = Array.from(
      new Set(extraTerms.map(normalizeConceptToken).filter(Boolean))
    );
    const files = await scanWorkspaceForMarkdown(this.workspaceDir);

    const mentionsByConcept = new Map<string, Map<string, number>>();
    const relatedByConcept = new Map<string, Map<string, number>>();
    const conceptsByFile = new Map<string, Set<string>>();

    for (const file of files) {
      let content = '';
      try {
        content = await readFile(file, 'utf-8');
      } catch {
        continue;
      }

      const relativePath = getRelativePath(file, this.workspaceDir);
      const paragraphs = splitIntoParagraphs(content);
      const fileConcepts = new Set<string>();

      for (const paragraph of paragraphs) {
        const concepts = extractConceptsFromTextNormalized(
          paragraph,
          normalizedConfig,
          normalizedExtraTerms
        );
        if (concepts.length === 0) continue;

        const unique = new Set(concepts);
        const terms = Array.from(unique);

        for (const term of terms) {
          fileConcepts.add(term);
          const mentionsForTerm = mentionsByConcept.get(term) ?? new Map<string, number>();
          mentionsForTerm.set(relativePath, (mentionsForTerm.get(relativePath) ?? 0) + 1);
          mentionsByConcept.set(term, mentionsForTerm);
        }

        for (let i = 0; i < terms.length; i += 1) {
          for (let j = i + 1; j < terms.length; j += 1) {
            const a = terms[i];
            const b = terms[j];

            const relatedA = relatedByConcept.get(a) ?? new Map<string, number>();
            relatedA.set(b, (relatedA.get(b) ?? 0) + 1);
            relatedByConcept.set(a, relatedA);

            const relatedB = relatedByConcept.get(b) ?? new Map<string, number>();
            relatedB.set(a, (relatedB.get(a) ?? 0) + 1);
            relatedByConcept.set(b, relatedB);
          }
        }
      }

      if (fileConcepts.size > 0) {
        conceptsByFile.set(relativePath, fileConcepts);
      }
    }

    const aliasesByCanonical = new Map<string, string[]>();
    for (const [alias, canonical] of Object.entries(config.aliases ?? {})) {
      const normalizedAlias = normalizeConceptToken(alias);
      const normalizedCanonical = normalizeConceptToken(canonical);
      if (!normalizedAlias || !normalizedCanonical) continue;
      const list = aliasesByCanonical.get(normalizedCanonical) ?? [];
      if (!list.includes(normalizedAlias)) list.push(normalizedAlias);
      aliasesByCanonical.set(normalizedCanonical, list);
    }

    const index: ConceptsIndex = {
      concepts: {},
      files: {},
    };

    for (const [concept, mentionMap] of mentionsByConcept.entries()) {
      const mentions = Array.from(mentionMap.entries())
        .map(([file, count]) => ({ file, count }))
        .sort((a, b) => b.count - a.count);

      const relatedMap = relatedByConcept.get(concept) ?? new Map<string, number>();
      const related = Object.fromEntries(
        Array.from(relatedMap.entries()).sort((a, b) => b[1] - a[1])
      );

      const aliases = aliasesByCanonical.get(concept);

      index.concepts[concept] = {
        mentions,
        related,
        ...(aliases && aliases.length > 0 ? { aliases } : {}),
      };
    }

    for (const [file, conceptSet] of conceptsByFile.entries()) {
      index.files[file] = {
        concepts: Array.from(conceptSet).sort(),
      };
    }

    return index;
  }

  async saveIndex(index: ConceptsIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  async loadIndex(): Promise<ConceptsIndex | null> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      return JSON.parse(raw) as ConceptsIndex;
    } catch {
      return null;
    }
  }

  async rebuildAndSave(): Promise<ConceptsIndex> {
    const index = await this.buildIndex();
    await this.saveIndex(index);
    return index;
  }
}

export const createConceptsIndex = (workspaceDir: string, configDir?: string): ConceptsIndexManager => {
  return new ConceptsIndexManager(workspaceDir, configDir);
};

export const getRelatedFilesForTerms = (
  index: ConceptsIndex,
  terms: string[],
  limit = 5
): string[] => {
  const scores = new Map<string, number>();

  for (const term of terms) {
    const entry = index.concepts[term];
    if (!entry) continue;
    for (const mention of entry.mentions) {
      scores.set(mention.file, (scores.get(mention.file) ?? 0) + mention.count);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file]) => file);
};
