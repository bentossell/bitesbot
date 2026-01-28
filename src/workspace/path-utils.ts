import { homedir } from 'node:os';
import { join } from 'node:path';

export const expandHome = (path: string): string => {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
};

export const getRelativePath = (filePath: string, workspaceDir: string): string => {
  const expandedDir = expandHome(workspaceDir);
  if (filePath.startsWith(expandedDir)) {
    return filePath.slice(expandedDir.length + 1);
  }
  return filePath;
};
