export {
  WikiLink,
  LinkTarget,
  extractLinksFromMarkdown,
  scanWorkspaceForLinks,
  resolveLink,
  resolveAllLinks,
} from './links.js';

export {
  BacklinksEntry,
  BacklinksIndex,
  LinksIndexManager,
  createLinksIndex,
} from './links-index.js';

export {
  ConceptConfig,
  NormalizedConceptConfig,
  normalizeConceptConfig,
  normalizeConceptToken,
  normalizeConcept,
  loadConceptConfig,
  saveConceptConfig,
  extractConceptsFromText,
  scanWorkspaceForMarkdown,
  getRepoNames,
} from './concepts.js';

export {
  ConceptMention,
  ConceptEntry,
  ConceptsIndex,
  ConceptsIndexManager,
  createConceptsIndex,
  getRelatedFilesForTerms,
} from './concepts-index.js';

export { expandHome, getRelativePath } from './path-utils.js';

export { WorkspaceInfo, WorkspaceConfig, WorkspaceRegistry, createWorkspaceRegistry, discoverWorkspaces, isWorkspaceDir, formatWorkspaceList } from "./registry.js";
