export {
  WikiLink,
  LinkTarget,
  expandHome,
  extractLinksFromMarkdown,
  scanWorkspaceForLinks,
  resolveLink,
  resolveAllLinks,
  getRelativePath,
} from './links.js';

export {
  BacklinksEntry,
  BacklinksIndex,
  LinksIndexManager,
  createLinksIndex,
} from './links-index.js';
