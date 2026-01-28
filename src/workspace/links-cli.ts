#!/usr/bin/env node

import { Command } from 'commander';
import { createLinksIndex } from './links-index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const program = new Command();

program
  .name('links')
  .description('Workspace bidirectional links management')
  .version('0.1.0');

program
  .command('rebuild')
  .description('Rebuild the links index from workspace markdown files')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (options) => {
    const manager = createLinksIndex(options.workspace, options.config);
    console.log(`Scanning workspace: ${options.workspace}`);
    const index = await manager.rebuildAndSave();
    const termCount = Object.keys(index).length;
    console.log(`Index rebuilt with ${termCount} terms`);
    console.log(`Saved to: ${manager.getIndexPath()}`);
  });

program
  .command('backlinks <term>')
  .description('Show what links TO a term')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (term, options) => {
    const manager = createLinksIndex(options.workspace, options.config);
    const backlinks = await manager.getBacklinks(term);

    if (backlinks.length === 0) {
      console.log(`No backlinks found for "${term}"`);
    } else {
      console.log(`Files linking to "${term}":`);
      backlinks.forEach(file => console.log(`  - ${file}`));
    }
  });

program
  .command('links <term>')
  .description('Show what a term links TO')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (term, options) => {
    const manager = createLinksIndex(options.workspace, options.config);
    const links = await manager.getForwardLinks(term);

    if (links.length === 0) {
      console.log(`"${term}" doesn't link to anything`);
    } else {
      console.log(`"${term}" links to:`);
      links.forEach(link => console.log(`  - ${link}`));
    }
  });

program
  .command('info <term>')
  .description('Show all information about a term')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (term, options) => {
    const manager = createLinksIndex(options.workspace, options.config);
    const backlinks = await manager.getBacklinks(term);
    const links = await manager.getForwardLinks(term);
    const target = await manager.getLinkTarget(term);

    console.log(`\nTerm: "${term}"\n`);

    if (target) {
      console.log(`Target: ${target.type} - ${target.path}`);
      console.log(`Exists: ${target.exists ? 'yes' : 'no'}\n`);
    }

    if (backlinks.length > 0) {
      console.log('Linked from:');
      backlinks.forEach(file => console.log(`  - ${file}`));
      console.log();
    }

    if (links.length > 0) {
      console.log('Links to:');
      links.forEach(link => console.log(`  - ${link}`));
      console.log();
    }

    if (backlinks.length === 0 && links.length === 0 && !target) {
      console.log('No information found. Try rebuilding the index first.');
    }
  });

program
  .command('show')
  .description('Show the entire links index')
  .option('-w, --workspace <dir>', 'Workspace directory', join(homedir(), 'bites'))
  .option('-c, --config <dir>', 'Config directory', join(homedir(), '.config', 'tg-gateway'))
  .action(async (options) => {
    const manager = createLinksIndex(options.workspace, options.config);
    const index = await manager.loadIndex();

    if (!index) {
      console.log('No index found. Run "rebuild" first.');
      return;
    }

    console.log(JSON.stringify(index, null, 2));
  });

program.parse();
