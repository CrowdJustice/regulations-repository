#!/usr/bin/env node
// Builds the public page: takes the page design and fills it with the live records from data/.
//
//   node agent/build-page.mjs [--out site/index.html] [--root DIR]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from './lib/store.mjs';

const agentDir = import.meta.dirname;
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const root = path.resolve(args.root ?? path.join(agentDir, '..'));
const out = path.resolve(args.out ?? path.join(root, 'site', 'index.html'));
const cfg = JSON.parse(await readFile(path.join(agentDir, 'config.json'), 'utf8'));
const store = createStore(root);

const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '');
const data = { countries: {}, records: [] };

for (const [code, country] of Object.entries(cfg.countries)) {
  const records = (await store.loadRecords(code)).filter((r) => r.status === 'live');
  if (!records.length) continue;
  const regulators = [...new Set((await store.loadSources(code)).filter((s) => s.enabled).map((s) => s.regulator))];
  data.countries[code] = {
    name: country.name,
    adj: country.adjective,
    sources: list(regulators),
    applies_to: Object.fromEntries(Object.entries(cfg.applies_to[code]).map(([key, v]) => [key, { label: v.label, ...(v.chip ? { chip: v.chip } : {}) }])),
  };
  for (const r of records) {
    data.records.push({
      id: r.id, country: r.country, status: r.status, regulator: r.regulator, topic: r.topic, stage: r.stage, title: r.title,
      summary: r.summary, what_changes: r.what_changes, applies_to: r.applies_to, who_it_applies_to: r.who_it_applies_to,
      dates: r.dates, source: r.source, last_checked: r.last_checked,
    });
  }
}

const template = await readFile(path.join(root, 'mockup', 'index.html'), 'utf8');
const block = /\/\* TRACKER-DATA:START[\s\S]*?TRACKER-DATA:END \*\//;
if (!block.test(template)) throw new Error('The page design has no TRACKER-DATA block to fill.');
// "<" is escaped so no record text can close the script tag.
const json = JSON.stringify(data, null, 1).replace(/</g, '\\u003c');
const page = template.replace(block, () => `/* TRACKER-DATA:START */\n  var DATA = ${json};\n  /* TRACKER-DATA:END */`);

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`Built ${path.relative(root, out)}: ${data.records.length} changes across ${Object.keys(data.countries).length} countries.`);
