#!/usr/bin/env node
// Admin actions. The admin page runs these through the "Admin action" workflow; they also work from a terminal.
//
//   node agent/admin.mjs <command> <target> [--reason "..."] [--payload '{...}'] [--commit]
//
//   revert  <id>                undo the last change made to a change
//   archive <id>                hide it from the page, and stop the assistant re-adding it
//   restore <id>                show an archived change again
//   edit    <id>                change its text, stage or dates (the new values are the payload)
//   publish <review name>       publish a held item, with the payload's edits if there are any
//   dismiss <review name>       throw a held item away
//   source-on | source-off <country>/<source id>
//   source-add <country>        add a source; the payload is { regulator, url, covers }
//
// The payload can also arrive in the PAYLOAD environment variable. Every edit passes the same checks as the assistant's work.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './lib/store.mjs';
import { validateRecord, validateUpdate } from './lib/checks.mjs';
import { fetchRaw, listAll } from './lib/web.mjs';

const COMMANDS = ['revert', 'archive', 'restore', 'edit', 'publish', 'dismiss', 'source-on', 'source-off', 'source-add'];
const EDITABLE = ['title', 'summary', 'what_changes', 'applies_to', 'who_it_applies_to', 'topic', 'stage', 'dates'];
const DATE_KEYS = ['proposed', 'decided', 'in_force', 'in_force_text', 'published'];
const MAX_NOTES = 8;

const [command, target, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  if (key === 'commit') flags.commit = true;
  else flags[key] = rest[++i];
}
const agentDir = import.meta.dirname;
const store = createStore(path.resolve(flags.root ?? path.join(agentDir, '..')));
const cfg = JSON.parse(await readFile(path.join(agentDir, 'config.json'), 'utf8'));
const today = flags.today ?? new Date().toISOString().slice(0, 10);
// The date where the country is, so a date that is today in Sydney is not refused as "in the future".
const todayIn = (country) => flags.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: cfg.countries[country]?.timezone ?? 'UTC' }).format(new Date());
const why = flags.reason?.trim() ? ` Reason: ${flags.reason.trim().slice(0, 200)}` : '';

// On GitHub the message is also raised as an error annotation, which is what the admin page shows.
function fail(message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${message.replace(/\r?\n/g, ' ')}`);
  console.error(message);
  process.exit(1);
}
if (!COMMANDS.includes(command) || !target) fail(`Usage: node agent/admin.mjs <${COMMANDS.join('|')}> <target> [--reason "..."] [--payload '{...}'] [--commit]`);

let payload = {};
const rawPayload = flags.payload ?? process.env.PAYLOAD ?? '';
if (rawPayload.trim()) {
  try { payload = JSON.parse(rawPayload); } catch { fail('The details sent with this action could not be read.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('The details sent with this action could not be read.');
}

const rel = (file) => path.relative(store.root, file);
const withNote = (notes, note) => [...(notes ?? []), note].slice(-MAX_NOTES);
// Stages additions, edits and deletions of exactly these files, then commits them.
function commit(files, subject, body) {
  if (!flags.commit) return;
  // One at a time: a deleted file that git never tracked has nothing to stage, and that is fine.
  for (const file of files) { try { store.git('add', '-A', '--', file); } catch { /* nothing to stage */ } }
  if (!store.git('status', '--porcelain', '--', ...files)) return;
  store.git('commit', '-q', '-m', subject, '-m', body, '--', ...files);
}

// The admin's edits, limited to the fields an admin may change.
function edits() {
  const out = {};
  for (const key of EDITABLE) if (key in payload) out[key] = payload[key];
  if ('dates' in out) {
    const dates = {};
    if (out.dates && typeof out.dates === 'object') {
      for (const key of DATE_KEYS) if (typeof out.dates[key] === 'string' && out.dates[key].trim()) dates[key] = out.dates[key].trim();
    }
    out.dates = dates;
  }
  return out;
}
function mustPass(record, prev) {
  const problems = [...validateRecord(record, cfg, todayIn(record.country)), ...(prev ? validateUpdate(prev, record) : [])];
  if (problems.length) fail(`Not saved: ${problems.join('; ')}.`);
}

let done;

if (['revert', 'archive', 'restore', 'edit'].includes(command)) {
  const current = await store.findRecord(target);
  if (!current) fail(`There is no change with id "${target}".`);
  const file = rel(store.recordFile(current));
  let next;
  if (command === 'revert') {
    const versions = store.git('log', '--format=%H', '--', file).split('\n').filter(Boolean);
    if (versions.length < 2) fail('This change has no earlier version to go back to. To take it off the page, archive it.');
    // Undoing an undo would bring back the very thing that was undone.
    if (store.git('log', '-1', '--format=%s', '--', file).startsWith('Revert:')) fail('The last change to this was already an undo. To change it further, edit it.');
    next = JSON.parse(store.git('show', `${versions[1]}:${file}`));
    const undone = current.history.at(-1);
    const wasUpdate = current.history.length > next.history.length;
    // A change that started on its start date would only start again tomorrow. The date itself has to change.
    if (wasUpdate && undone.event === 'Came into force.') fail('This change started automatically on its start date. To change that, edit its stage and start date.');
    next.admin_notes = withNote(next.admin_notes, wasUpdate
      ? `An admin reverted this update on ${today}: "${undone.event}" (${undone.url}).${why} Do not apply it again from any source.`
      : `An admin undid the last change on ${today}.${why}`);
    done = `Revert: ${next.title}`;
  } else if (command === 'edit') {
    const changes = edits();
    if (!Object.keys(changes).length) fail('Nothing to change was sent.');
    next = { ...current, ...changes };
    if (JSON.stringify(next) === JSON.stringify(current)) fail('Nothing was changed.');
    mustPass(next);
    const note = `An admin edited this change on ${today}.${why} Keep the admin's wording unless a fact changes.`;
    const notes = (current.admin_notes ?? []).filter((n) => !n.startsWith(`An admin edited this change on ${today}.`));
    next.admin_notes = withNote(notes, note);
    done = `Edit: ${next.title}`;
  } else {
    const status = command === 'archive' ? 'archived' : 'live';
    if (current.status === status) fail(`This change is already ${status === 'live' ? 'on the page' : 'archived'}.`);
    next = { ...current, status, admin_notes: withNote(current.admin_notes, `An admin ${command === 'archive' ? 'archived' : 'restored'} this change on ${today}.${why}`) };
    done = `${command === 'archive' ? 'Archive' : 'Restore'}: ${next.title}`;
  }
  await store.saveRecord(next);
  commit([file], done, target);
}

if (['publish', 'dismiss'].includes(command)) {
  if (!/^[\w.-]+$/.test(target)) fail('That is not a held item.');
  const reviewFile = path.join('review', `${target}.json`);
  if (!existsSync(path.join(store.root, reviewFile))) fail('That held item no longer exists. It may already have been published or dismissed.');
  const held = JSON.parse(await readFile(path.join(store.root, reviewFile), 'utf8'));
  // The change it would update, as it stands now. It may have moved on since the item was held.
  const prev = held.current_record ? await store.findRecord(held.current_record.id) : null;
  const files = [reviewFile];

  if (command === 'publish') {
    if (!held.proposed_record) fail('The assistant drafted nothing for this item, so there is nothing to publish.');
    if (held.current_record && !prev) fail('The change this would update no longer exists.');
    const draft = { ...held.proposed_record, ...edits(), status: 'live' };
    const event = held.proposed_record.history?.at(-1);
    const record = prev
      ? { ...draft, id: prev.id, country: prev.country, regulator: prev.regulator, history: [...prev.history, ...(event ? [event] : [])].slice(-cfg.limits.history_max_items), admin_notes: prev.admin_notes ?? [] }
      : { ...draft, admin_notes: draft.admin_notes ?? [] };
    if (!prev && await store.findRecord(record.id)) fail(`A change with the id "${record.id}" already exists. Dismiss this item, or edit the existing change instead.`);
    if (prev?.status === 'archived') fail('The change this would update is archived. Restore it first.');
    mustPass(record, prev);
    record.last_checked = today;
    record.admin_notes = withNote(record.admin_notes, `An admin published this on ${today} after the assistant held it.${why}`);
    await store.saveRecord(record);
    files.push(rel(store.recordFile(record)));
    done = `Publish held item: ${record.title}`;
  } else {
    // Dismissing an update is remembered on the change, so the assistant does not try the same update again.
    if (prev && held.proposed_record) {
      const event = held.proposed_record.history?.at(-1);
      prev.admin_notes = withNote(prev.admin_notes, `An admin dismissed a proposed update on ${today}${event ? `: "${event.event}" (${event.url})` : ''}.${why} Do not apply it again from any source.`);
      await store.saveRecord(prev);
      files.push(rel(store.recordFile(prev)));
    }
    done = `Dismiss held item: ${held.proposed_record?.title ?? held.item?.title ?? target}`;
  }
  await unlink(path.join(store.root, reviewFile));
  commit(files, done, `${target}${why}`);
}

if (command.startsWith('source-')) {
  const [country, id] = target.split('/');
  if (!cfg.countries[country]) fail(`"${country}" is not a country the tracker covers.`);
  const file = path.join('sources', `${country}.json`);
  const sources = await store.loadSources(country);

  if (command === 'source-add') {
    const regulator = String(payload.regulator ?? '').trim();
    let url;
    try { url = new URL(String(payload.url ?? '').trim()); } catch { fail('That is not a web address.'); }
    if (!/^https?:$/.test(url.protocol)) fail('That is not a web address.');
    if (!regulator || regulator.length > 40) fail('Give the regulator a name of 40 characters or fewer.');
    if (sources.some((s) => s.url === url.toString())) fail('That address is already a source.');
    const source = await describeSource(url, regulator, String(payload.covers ?? '').trim());
    const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let newId = `${slug(regulator)}-${slug(url.pathname.split('/').filter(Boolean).pop()?.replace(/\.[a-z]+$/, '') ?? 'news')}`.slice(0, 50).replace(/-$/, '');
    for (let n = 2; sources.some((s) => s.id === newId); n++) newId = `${newId.replace(/-\d+$/, '')}-${n}`;
    sources.push({ id: newId, ...source });
    done = `Add source: ${regulator}`;
  } else {
    const source = sources.find((s) => s.id === id);
    if (!source) fail(`There is no source "${id}" for ${cfg.countries[country].name}.`);
    const enabled = command === 'source-on';
    if (source.enabled === enabled) fail(`That source is already ${enabled ? 'on' : 'off'}.`);
    source.enabled = enabled;
    done = `Turn ${enabled ? 'on' : 'off'} source: ${source.regulator} (${source.id})`;
  }
  await writeFile(path.join(store.root, file), `${JSON.stringify(sources, null, 2)}\n`);
  commit([file], done, target);
}

console.log(done);

// Works out how to read a new source: as a feed, or as a page whose item links can be told apart from its menus.
async function describeSource(url, regulator, covers) {
  const address = url.toString();
  const base = { regulator, covers: covers || 'Added by an admin', enabled: true };
  let body;
  try { body = await fetchRaw(address); } catch (error) { fail(`That address could not be read: ${error.message}.`); }
  if (/<(rss|feed)\b/i.test(body.slice(0, 3000))) {
    const feed = { ...base, how: 'feed', url: address };
    if (!(await listAll(feed)).length) fail('That feed lists no items.');
    return feed;
  }
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const here = `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\.[a-z]+$/, '')}`;
  const parent = here.slice(0, here.lastIndexOf('/'));
  // Item links usually sit under the listing's own address; failing that under its parent; failing that anywhere on the site.
  const patterns = [`^${quote(here)}/.+`, ...(parent.length > url.origin.length ? [`^${quote(parent)}/.+`] : []), `^${quote(url.origin)}/[^?]+$`];
  for (const match of patterns) {
    const page = { ...base, how: 'page', url: address, match, main_only: true };
    if ((await listAll(page)).length >= 3) return page;
  }
  return fail('No list of items was found at that address. Give the address of the page that lists the regulator\'s news or consultations.');
}
