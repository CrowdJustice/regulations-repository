#!/usr/bin/env node
// Admin actions on one change.
//
//   node agent/admin.mjs revert  <id> [--reason "..."] [--commit]   undo the last change made to it
//   node agent/admin.mjs archive <id> [--reason "..."] [--commit]   hide it from the page, and stop the assistant re-adding it
//   node agent/admin.mjs restore <id> [--reason "..."] [--commit]   show an archived change again

import path from 'node:path';
import { createStore } from './lib/store.mjs';

const [command, id, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  if (key === 'commit') flags.commit = true;
  else flags[key] = rest[++i];
}
const store = createStore(path.resolve(flags.root ?? path.join(import.meta.dirname, '..')));
const today = flags.today ?? new Date().toISOString().slice(0, 10);
const why = flags.reason?.trim() ? ` Reason: ${flags.reason.trim()}` : '';

const fail = (message) => { console.error(message); process.exit(1); };
if (!['revert', 'archive', 'restore'].includes(command) || !id) fail('Usage: node agent/admin.mjs <revert|archive|restore> <id> [--reason "..."] [--commit]');

const current = await store.findRecord(id);
if (!current) fail(`There is no change with id "${id}".`);
const file = path.relative(store.root, store.recordFile(current));

let next;
let subject;
if (command === 'revert') {
  const versions = store.git('log', '--format=%H', '--', file).split('\n').filter(Boolean);
  if (versions.length < 2) fail(`"${id}" has no earlier version to go back to. To remove it, use: archive ${id}`);
  next = JSON.parse(store.git('show', `${versions[1]}:${file}`));
  const undone = current.history.at(-1);
  const wasUpdate = current.history.length > next.history.length;
  next.admin_notes = [
    ...(next.admin_notes ?? []),
    wasUpdate
      ? `An admin reverted this update on ${today}: "${undone.event}" (${undone.url}).${why} Do not apply it again from any source.`
      : `An admin undid the last change on ${today}.${why}`,
  ];
  subject = `Revert: ${next.title}`;
} else {
  const status = command === 'archive' ? 'archived' : 'live';
  if (current.status === status) fail(`"${id}" is already ${status}.`);
  next = { ...current, status, admin_notes: [...(current.admin_notes ?? []), `An admin ${command === 'archive' ? 'archived' : 'restored'} this change on ${today}.${why}`] };
  subject = `${command === 'archive' ? 'Archive' : 'Restore'}: ${next.title}`;
}

await store.saveRecord(next);
if (flags.commit) store.commit([file], subject, id);
console.log(`${subject} (${id})`);
