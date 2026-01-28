import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

export interface WikiLink {
  term: string;
  sourceFile: string;
  line?: number;
}

export interface LinkTarget {
  type: 'repo' | 'file' | 'topic';
  path: string;
  exists: boolean;
}

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

export function expandHome(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export async function extractLinksFromMarkdown(
  filePath: string,
  content?: string
): Promise<WikiLink[]> {
  const text = content ?? await readFile(filePath, 'utf-8');
  const links: WikiLink[] = [];
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    let match;
    const regex = new RegExp(LINK_PATTERN);
    while ((match = regex.exec(line)) !== null) {
      links.push({
        term: match[1].trim(),
        sourceFile: filePath,
        line: index + 1,
      });
    }
  });

  return links;
}

export async function scanWorkspaceForLinks(
  workspaceDir: string
): Promise<WikiLink[]> {
  const expandedDir = expandHome(workspaceDir);
  const allLinks: WikiLink[] = [];

  async function scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            await scanDirectory(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const links = await extractLinksFromMarkdown(fullPath);
          allLinks.push(...links);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }

  await scanDirectory(expandedDir);
  return allLinks;
}

export async function resolveLink(
  term: string,
  workspaceDir: string
): Promise<LinkTarget | null> {
  const expandedDir = expandHome(workspaceDir);
  const reposDir = join(dirname(expandedDir), 'repos');

  // Try to resolve as repo
  const repoPath = join(reposDir, term);
  try {
    const repoStat = await stat(repoPath);
    if (repoStat.isDirectory()) {
      return { type: 'repo', path: repoPath, exists: true };
    }
  } catch {
    // Not a repo
  }

  // Try to resolve as file in workspace
  const filePath = join(expandedDir, term.endsWith('.md') ? term : `${term}.md`);
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return { type: 'file', path: filePath, exists: true };
    }
  } catch {
    // Not a direct file
  }

  // Try to resolve as file in memory/ subdirectory
  const memoryPath = join(expandedDir, 'memory', term.endsWith('.md') ? term : `${term}.md`);
  try {
    const memoryStat = await stat(memoryPath);
    if (memoryStat.isFile()) {
      return { type: 'file', path: memoryPath, exists: true };
    }
  } catch {
    // Not in memory/
  }

  // If not found, treat as topic (can be created later)
  const topicPath = join(expandedDir, 'memory', term.endsWith('.md') ? term : `${term}.md`);
  return { type: 'topic', path: topicPath, exists: false };
}

export async function resolveAllLinks(
  links: WikiLink[],
  workspaceDir: string
): Promise<Map<string, LinkTarget>> {
  const resolved = new Map<string, LinkTarget>();
  const uniqueTerms = new Set(links.map(l => l.term));

  for (const term of uniqueTerms) {
    const target = await resolveLink(term, workspaceDir);
    if (target) {
      resolved.set(term, target);
    }
  }

  return resolved;
}

export function getRelativePath(filePath: string, workspaceDir: string): string {
  const expandedDir = expandHome(workspaceDir);
  if (filePath.startsWith(expandedDir)) {
    return filePath.slice(expandedDir.length + 1);
  }
  return filePath;
}
