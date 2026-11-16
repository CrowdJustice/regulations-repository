#!/usr/bin/env node
// Builds the website into site/: the public tracker (index.html) and the admin page (admin.html).
// The public page gets the live records from data/. The admin page gets no data at all: it reads the repository itself.
//
//   node agent/build-page.mjs [--out DIR] [--root DIR] [--fragment FILE]
//
// --fragment also writes the public page without the <html> wrapper, for previews that add their own.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createStore } from './lib/store.mjs';

const agentDir = import.meta.dirname;
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const root = path.resolve(args.root ?? path.join(agentDir, '..'));
const outDir = path.resolve(args.out ?? path.join(root, 'site'));
const cfg = JSON.parse(await readFile(path.join(agentDir, 'config.json'), 'utf8'));
const store = createStore(root);

// Replaces the block between "/* NAME:START ... NAME:END */" in a page with real content.
function fill(text, name, content) {
  const block = new RegExp(`/\\* ${name}:START[\\s\\S]*?${name}:END \\*/`);
  if (!block.test(text)) throw new Error(`There is no ${name} block to fill.`);
  return text.replace(block, () => `/* ${name}:START */\n${content}\n  /* ${name}:END */`);
}

// ---- The public page ----

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
    applies_to: Object.fromEntries(Object.entries(cfg.applies_to[code]).map(([key, v]) => [key, { label: v.label, ...(v.chip ? { chip: v.chip } : {}), ...(v.includes ? { includes: v.includes } : {}) }])),
  };
  for (const r of records) {
    data.records.push({
      id: r.id, country: r.country, status: r.status, regulator: r.regulator, topic: r.topic, stage: r.stage, title: r.title,
      summary: r.summary, what_changes: r.what_changes, applies_to: r.applies_to, who_it_applies_to: r.who_it_applies_to,
      dates: r.dates, source: r.source, last_checked: r.last_checked,
    });
  }
}

// "<" is escaped so no record text can close the script tag.
const json = JSON.stringify(data, null, 1).replace(/</g, '\\u003c');
const fragment = fill(await readFile(path.join(root, 'web', 'index.html'), 'utf8'), 'TRACKER-DATA', `  var DATA = ${json};`);

// The design is written as a fragment (title, styles, then the page). A website needs the full document around it.
const stylesEnd = fragment.indexOf('</style>') + '</style>'.length;
const publicPage = [
  '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="description" content="Changes to legal regulation that affect law firms: what changed, who it applies to and when. Checked against official sources.">',
  fragment.slice(0, stylesEnd), '</head>', '<body>', fragment.slice(stylesEnd).trim(), '</body>', '</html>', '',
].join('\n');

// ---- The admin page ----

const checks = (await readFile(path.join(agentDir, 'lib', 'checks.mjs'), 'utf8')).replace(/^export /gm, '');
let script = await readFile(path.join(root, 'web', 'admin.js'), 'utf8');
script = fill(script, 'TRACKER-CONFIG', `  var CONFIG = ${JSON.stringify({ repo: cfg.repo, branch: cfg.branch })};`);
script = fill(script, 'TRACKER-CHECKS', checks);
script = `\n${script.replace(/<\/script/gi, '<\\/script')}\n`;

// Only this exact script may run on the admin page, and it may only talk to GitHub.
const policy = [
  "default-src 'none'", `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  'connect-src https://api.github.com https://raw.githubusercontent.com', "base-uri 'none'", "form-action 'none'",
].join('; ');
const shell = await readFile(path.join(root, 'web', 'admin.html'), 'utf8');
const slot = /<script>[\s\S]*?TRACKER-ADMIN-SCRIPT[\s\S]*?<\/script>/;
if (!slot.test(shell) || !shell.includes('<!-- TRACKER-CSP -->')) throw new Error('web/admin.html is missing its script or policy placeholder.');
const adminPage = shell
  .replace('<!-- TRACKER-CSP -->', `<meta http-equiv="Content-Security-Policy" content="${policy}">`)
  .replace(slot, () => `<script>${script}</script>`);

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'index.html'), publicPage);
await writeFile(path.join(outDir, 'admin.html'), adminPage);
await writeFile(path.join(outDir, '.nojekyll'), '');
if (args.fragment) await writeFile(path.resolve(args.fragment), fragment);
console.log(`Built ${path.relative(root, outDir) || '.'}: ${data.records.length} changes across ${Object.keys(data.countries).length} countries, plus the admin page.`);
