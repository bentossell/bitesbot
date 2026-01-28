#!/usr/bin/env node

import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConceptsIndex, getRelatedFilesForTerms } from './concepts-index.js';
import {
  loadConceptConfig,
  normalizeConceptConfig,
  normalizeConceptToken,
  saveConceptConfig,
} from './concepts.js';
import { getRelativePath } from './links.js';

const program = new Command();

program
  .name('tg-concepts')
  .description('Workspace concept graph management')
  .version('0.1.0');

program
  .command('rebuild')
  .description('Rebuild the concepts index from workspace markdown files')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (options) => {
    const manager = createConceptsIndex(options.workspace, options.config);
    console.log(`Scanning workspace: ${options.workspace}`);
    const index = await manager.rebuildAndSave();
    const conceptCount = Object.keys(index.concepts).length;
    console.log(`Index rebuilt with ${conceptCount} concepts`);
    console.log(`Saved to: ${manager.getIndexPath()}`);
  });

program
  .command('concepts <term>')
  .description('Show files that mention a concept')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (term, options) => {
    const manager = createConceptsIndex(options.workspace, options.config);
    const index = await manager.loadIndex();

    if (!index) {
      console.log('No index found. Run "rebuild" first.');
      return;
    }

    const config = await loadConceptConfig(options.config);
    const normalizedConfig = normalizeConceptConfig(config);
    const normalizedTerm = normalizeConceptToken(term);
    const canonical = normalizedConfig.aliases.get(normalizedTerm) ?? normalizedTerm;
    const entry = index.concepts[canonical];

    if (!entry) {
      console.log(`No concept found for "${term}".`);
      return;
    }

    console.log(`Files mentioning "${canonical}":`);
    entry.mentions.forEach((mention) => {
      console.log(`  - ${mention.file} (${mention.count})`);
    });
  });

program
  .command('related <term>')
  .description('Show related concepts and files')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (term, options) => {
    const manager = createConceptsIndex(options.workspace, options.config);
    const index = await manager.loadIndex();

    if (!index) {
      console.log('No index found. Run "rebuild" first.');
      return;
    }

    const config = await loadConceptConfig(options.config);
    const normalizedConfig = normalizeConceptConfig(config);
    const normalizedTerm = normalizeConceptToken(term);
    const canonical = normalizedConfig.aliases.get(normalizedTerm) ?? normalizedTerm;
    const entry = index.concepts[canonical];

    if (!entry) {
      console.log(`No concept found for "${term}".`);
      return;
    }

    const relatedEntries = Object.entries(entry.related).slice(0, 10);
    if (relatedEntries.length > 0) {
      console.log(`Related concepts for "${canonical}":`);
      relatedEntries.forEach(([related, score]) => {
        console.log(`  - ${related} (${score})`);
      });
    }

    const relatedFiles = getRelatedFilesForTerms(index, [canonical], 5);
    if (relatedFiles.length > 0) {
      console.log('Related files:');
      relatedFiles.forEach((file) => console.log(`  - ${file}`));
    }
  });

program
  .command('file <path>')
  .description('Show concepts found in a file')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (path, options) => {
    const manager = createConceptsIndex(options.workspace, options.config);
    const index = await manager.loadIndex();

    if (!index) {
      console.log('No index found. Run "rebuild" first.');
      return;
    }

    const relative = getRelativePath(path, options.workspace);
    const entry = index.files[relative];

    if (!entry) {
      console.log(`No concepts found for "${relative}".`);
      return;
    }

    console.log(`Concepts in ${relative}:`);
    entry.concepts.forEach((concept) => console.log(`  - ${concept}`));
  });

const aliasesCommand = program
  .command('aliases')
  .description('Manage alias mappings');

aliasesCommand
  .command('list')
  .description('List aliases')
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (options) => {
    const config = await loadConceptConfig(options.config);
    const entries = Object.entries(config.aliases ?? {}).sort((a, b) => a[0].localeCompare(b[0]));

    if (entries.length === 0) {
      console.log('No aliases configured.');
      return;
    }

    console.log('Aliases:');
    entries.forEach(([alias, canonical]) => {
      console.log(`  ${alias} -> ${canonical}`);
    });
  });

aliasesCommand
  .command('add <alias> <canonical>')
  .description('Add an alias mapping')
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (alias, canonical, options) => {
    const config = await loadConceptConfig(options.config);
    const normalizedAlias = normalizeConceptToken(alias);
    const normalizedCanonical = normalizeConceptToken(canonical);

    if (!normalizedAlias || !normalizedCanonical) {
      console.log('Alias and canonical terms must be non-empty.');
      return;
    }

    config.aliases = config.aliases ?? {};
    config.aliases[normalizedAlias] = normalizedCanonical;
    await saveConceptConfig(config, options.config);
    console.log(`Added alias: ${normalizedAlias} -> ${normalizedCanonical}`);
  });

aliasesCommand
  .command('remove <alias>')
  .description('Remove an alias mapping')
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (alias, options) => {
    const config = await loadConceptConfig(options.config);
    const normalizedAlias = normalizeConceptToken(alias);

    if (!normalizedAlias || !config.aliases || !config.aliases[normalizedAlias]) {
      console.log(`Alias not found: ${alias}`);
      return;
    }

    delete config.aliases[normalizedAlias];
    await saveConceptConfig(config, options.config);
    console.log(`Removed alias: ${normalizedAlias}`);
  });

program.parse();
