import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  LinkTarget,
  scanWorkspaceForLinks,
  resolveAllLinks,
  getRelativePath,
} from './links.js';

export interface BacklinksEntry {
  linkedFrom: string[];
  linksTo: string[];
  target?: LinkTarget;
}

export interface BacklinksIndex {
  [term: string]: BacklinksEntry;
}

export class LinksIndexManager {
  private indexPath: string;
  private workspaceDir: string;

  constructor(workspaceDir: string, configDir?: string) {
    this.workspaceDir = workspaceDir;
    const baseDir = configDir ?? join(homedir(), '.config', 'tg-gateway');
    this.indexPath = join(baseDir, 'links-index.json');
  }

  async buildIndex(): Promise<BacklinksIndex> {
    const links = await scanWorkspaceForLinks(this.workspaceDir);
    const resolved = await resolveAllLinks(links, this.workspaceDir);

    const index: BacklinksIndex = {};

    // Build backlinks
    for (const link of links) {
      const { term, sourceFile } = link;
      const relativeSource = getRelativePath(sourceFile, this.workspaceDir);

      if (!index[term]) {
        index[term] = {
          linkedFrom: [],
          linksTo: [],
          target: resolved.get(term),
        };
      }

      if (!index[term].linkedFrom.includes(relativeSource)) {
        index[term].linkedFrom.push(relativeSource);
      }
    }

    // Build forward links (what each file links to)
    // Use full relative path with .md extension as key to avoid collisions
    // e.g., memory/foo.md stays as "memory/foo.md" instead of "memory/foo"
    for (const link of links) {
      const { term, sourceFile } = link;
      const relativeSource = getRelativePath(sourceFile, this.workspaceDir);

      // Find or create entry for the source file using full path as key
      if (!index[relativeSource]) {
        index[relativeSource] = {
          linkedFrom: [],
          linksTo: [],
        };
      }

      if (!index[relativeSource].linksTo.includes(term)) {
        index[relativeSource].linksTo.push(term);
      }
    }

    return index;
  }

  async saveIndex(index: BacklinksIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  async loadIndex(): Promise<BacklinksIndex | null> {
    try {
      const content = await readFile(this.indexPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async rebuildAndSave(): Promise<BacklinksIndex> {
    const index = await this.buildIndex();
    await this.saveIndex(index);
    return index;
  }

  async getBacklinks(term: string): Promise<string[]> {
    const index = await this.loadIndex();
    if (!index || !index[term]) {
      return [];
    }
    return index[term].linkedFrom;
  }

  async getForwardLinks(term: string): Promise<string[]> {
    const index = await this.loadIndex();
    if (!index || !index[term]) {
      return [];
    }
    return index[term].linksTo;
  }

  async getLinkTarget(term: string): Promise<LinkTarget | undefined> {
    const index = await this.loadIndex();
    if (!index || !index[term]) {
      return undefined;
    }
    return index[term].target;
  }

  getIndexPath(): string {
    return this.indexPath;
  }
}

export function createLinksIndex(
  workspaceDir: string,
  configDir?: string
): LinksIndexManager {
  return new LinksIndexManager(workspaceDir, configDir);
}
