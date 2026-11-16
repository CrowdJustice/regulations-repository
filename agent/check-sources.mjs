#!/usr/bin/env node
// Reads every source that is switched on and reports what it found. No AI, so it needs no credential.
//
//   node agent/check-sources.mjs [--country uk] [--since YYYY-MM-DD] [--root DIR]
//
// Set TRACKER_RECORD to a folder to also keep a copy of every page read.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from './lib/store.mjs';
import { newItems, fetchPageText } from './lib/web.mjs';

const agentDir = import.meta.dirname;
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const cfg = JSON.parse(await readFile(path.join(agentDir, 'config.json'), 'utf8'));
const store = createStore(path.resolve(args.root ?? path.join(agentDir, '..')));
const today = new Date().toISOString().slice(0, 10);
const since = args.since ?? new Date(Date.parse(today) - cfg.window_days * 864e5).toISOString().slice(0, 10);
const countries = args.country ? [args.country] : Object.keys(cfg.applies_to);
const seen = await store.loadSeen();

const lines = [`Sources checked on ${today}, looking back to ${since}.`, '', '| Source | Listed | Relevant | To read | Read | Problem |', '|---|---|---|---|---|---|'];
const examples = [];
let failed = 0;

for (const country of countries) {
  for (const source of (await store.loadSources(country)).filter((s) => s.enabled)) {
    let found;
    try {
      found = await newItems(source, { seen, since, max: cfg.max_items_per_source });
    } catch (error) {
      failed++;
      lines.push(`| ${source.id} | | | | | Could not read the listing: ${error.message} |`);
      continue;
    }
    let read = 0;
    const problems = [];
    for (const item of found.batch) {
      try {
        await fetchPageText(item.url);
        read++;
      } catch (error) {
        problems.push(`${error.message} (${item.url})`);
      }
    }
    if (found.listed === 0) problems.unshift('The listing has no items; the address or pattern may be wrong');
    if (problems.length) failed++;
    lines.push(`| ${source.id} | ${found.listed} | ${found.matched} | ${found.batch.length} | ${read} | ${problems.join('; ')} |`);
    for (const item of found.batch.slice(-3)) examples.push(`- ${source.id}: ${item.title || item.url}${item.date ? ` (${item.date})` : ''}`);
  }
}

console.log([...lines, '', 'Latest items:', ...examples].join('\n'));
process.exitCode = failed ? 1 : 0;
