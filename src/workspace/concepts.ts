import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandHome } from './path-utils.js';

export type ConceptConfig = {
  stop?: string[];
  allow?: string[];
  aliases?: Record<string, string>;
};

export type NormalizedConceptConfig = {
  stop: Set<string>;
  allow: Set<string>;
  aliases: Map<string, string>;
};

const DEFAULT_CONFIG: ConceptConfig = {
  stop: [],
  allow: [],
  aliases: {},
};

const normalizeTerm = (value: string): string => {
  return value
    .replace(/\u2019/g, "'")
    .replace(/[_]/g, ' ')
    .replace(/[^\w\s'-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
};

export const normalizeConceptToken = (value: string): string => normalizeTerm(value);

export const normalizeConceptConfig = (config: ConceptConfig): NormalizedConceptConfig => {
  const stop = new Set((config.stop ?? []).map(normalizeTerm).filter(Boolean));
  const allow = new Set((config.allow ?? []).map(normalizeTerm).filter(Boolean));
  const aliases = new Map<string, string>();

  for (const [alias, canonical] of Object.entries(config.aliases ?? {})) {
    const normalizedAlias = normalizeTerm(alias);
    const normalizedCanonical = normalizeTerm(canonical);
    if (normalizedAlias && normalizedCanonical) {
      aliases.set(normalizedAlias, normalizedCanonical);
    }
  }

  return { stop, allow, aliases };
};

export const normalizeConcept = (term: string, config: NormalizedConceptConfig): string | null => {
  const normalized = normalizeTerm(term);
  if (!normalized) return null;

  const mapped = config.aliases.get(normalized) ?? normalized;
  if (config.stop.has(mapped) && !config.allow.has(mapped)) return null;
  if (config.stop.has(normalized) && !config.allow.has(normalized)) return null;

  return mapped;
};

export const getConceptConfigPath = (configDir?: string): string => {
  const baseDir = configDir ?? join(homedir(), '.config', 'tg-gateway');
  return join(baseDir, 'concepts.config.json');
};

export const loadConceptConfig = async (configDir?: string): Promise<ConceptConfig> => {
  const configPath = getConceptConfigPath(configDir);
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as ConceptConfig;
    return {
      stop: parsed.stop ?? DEFAULT_CONFIG.stop,
      allow: parsed.allow ?? DEFAULT_CONFIG.allow,
      aliases: parsed.aliases ?? DEFAULT_CONFIG.aliases,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};

export const saveConceptConfig = async (config: ConceptConfig, configDir?: string): Promise<void> => {
  const configPath = getConceptConfigPath(configDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripMarkdown = (text: string): string => {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
};

export const splitIntoParagraphs = (markdown: string): string[] => {
  const stripped = stripMarkdown(markdown);
  return stripped
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
};

const normalizeExtraTerms = (terms: string[]): string[] => {
  const normalized = new Set<string>();
  for (const term of terms) {
    const cleaned = normalizeTerm(term);
    if (cleaned) normalized.add(cleaned);
  }
  return Array.from(normalized);
};

export const extractConceptsFromTextNormalized = (
  text: string,
  config: NormalizedConceptConfig,
  extraTerms: string[] = []
): string[] => {
  const concepts = new Set<string>();
  const cleaned = stripMarkdown(text);

  const addConcept = (term: string) => {
    const normalized = normalizeConcept(term, config);
    if (normalized) concepts.add(normalized);
  };

  for (const match of cleaned.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (match[1]) addConcept(match[1]);
  }

  for (const match of cleaned.matchAll(/(^|\s)#([A-Za-z][\w-]{1,})/g)) {
    if (match[2]) addConcept(match[2]);
  }

  for (const match of cleaned.matchAll(/\b([A-Z][A-Za-z0-9']+(?:\s+[A-Z][A-Za-z0-9']+){0,3})\b/g)) {
    if (match[1]) addConcept(match[1]);
  }

  const normalizedExtras = normalizeExtraTerms(extraTerms);
  if (normalizedExtras.length > 0) {
    const lower = cleaned.toLowerCase();
    for (const term of normalizedExtras) {
      if (!term) continue;
      if (term.includes(' ')) {
        if (lower.includes(term)) addConcept(term);
      } else {
        const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
        if (regex.test(cleaned)) addConcept(term);
      }
    }
  }

  return Array.from(concepts);
};

export const extractConceptsFromText = (
  text: string,
  config: ConceptConfig,
  extraTerms: string[] = []
): string[] => {
  const normalizedConfig = normalizeConceptConfig(config);
  return extractConceptsFromTextNormalized(text, normalizedConfig, extraTerms);
};

export const scanWorkspaceForMarkdown = async (workspaceDir: string): Promise<string[]> => {
  const expandedDir = expandHome(workspaceDir);
  const files: string[] = [];

  const scanDirectory = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            await scanDirectory(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };

  await scanDirectory(expandedDir);
  return files;
};

export const getRepoNames = async (workspaceDir: string): Promise<string[]> => {
  const expandedDir = expandHome(workspaceDir);
  const reposDir = join(dirname(expandedDir), 'repos');
  try {
    const entries = await readdir(reposDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};
