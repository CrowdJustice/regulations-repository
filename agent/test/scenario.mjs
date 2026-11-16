#!/usr/bin/env node
// A trial run against made-up regulator pages, from first sighting to in force.
// It calls the real AI, so it takes a few minutes and costs a little.
//
//   node agent/test/scenario.mjs

import { mkdtemp, mkdir, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateRecord } from '../lib/checks.mjs';

const here = import.meta.dirname;
const cfg = JSON.parse(await readFile(path.join(here, '..', 'config.json'), 'utf8'));
const root = await mkdtemp(path.join(os.tmpdir(), 'tracker-scenario-'));
const pages = path.join(root, '.pages');
await mkdir(path.join(root, 'sources'), { recursive: true });
await cp(path.join(here, 'fixtures'), pages, { recursive: true });
await cp(path.join(pages, 'sources.json'), path.join(root, 'sources', 'uk.json'));
await writeFile(path.join(root, '.gitignore'), '.pages/\ndigest.md\n');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.name', 'scenario');
git('config', 'user.email', 'scenario@example.test');
git('add', '-A');
git('commit', '-q', '-m', 'Start');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

async function runAssistant(today, listing) {
  const slugs = ['consultation', 'chair', 'fine', 'reminder', 'decision', 'ai-warning', 'oversight'];
  const index = { 'https://nlsa.test/news/': listing, ...Object.fromEntries(slugs.map((s) => [`https://nlsa.test/news/${s}`, `${s}.html`])) };
  await writeFile(path.join(pages, 'index.json'), JSON.stringify(index));
  const out = execFileSync('node', [path.join(here, '..', 'run.mjs'), '--root', root, '--today', today, '--country', 'uk', '--commit'],
    { encoding: 'utf8', env: { ...process.env, TRACKER_FIXTURES: pages } });
  console.log(`  ${out.trim()}`);
  const log = JSON.parse(await readFile(path.join(root, 'data', 'log', `${today}.json`), 'utf8'));
  return log.at(-1);
}

const admin = (command, id, today, payload) => console.log(`  ${execFileSync('node', [path.join(here, '..', 'admin.mjs'), command, id, '--root', root, '--today', today, '--commit',
  ...(payload ? ['--payload', JSON.stringify(payload)] : [])], { encoding: 'utf8' }).trim()}`);

async function records() {
  const dir = path.join(root, 'data', 'uk');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}
const withinLimits = (all, today) => all.every((r) => validateRecord(r, cfg, today).length === 0);

console.log('\n1. First run: a consultation, an appointment and a fine against a named solicitor');
let run = await runAssistant('2026-10-09', 'listing-1.html');
let all = await records();
let money = all.find((r) => r.applies_to.includes('money'));
check('one change published', run.published.length === 1 && all.length === 1, JSON.stringify(run.published));
check('it is a proposal dated 2 Oct 2026', money?.stage === 'proposed' && money?.dates.proposed === '2026-10-02', JSON.stringify(money?.dates));
check('the appointment and the fine are ignored', run.ignored.length === 2, JSON.stringify(run.ignored));
check('nothing held', run.held.length === 0, JSON.stringify(run.held));

console.log('\n2. Second run: a reminder, the final decision on the same change, and a warning notice');
run = await runAssistant('2026-11-13', 'listing-2.html');
all = await records();
const after = all.find((r) => r.id === money?.id);
const warning = all.find((r) => r.stage === 'guidance');
check('the decision updates the existing change, with no duplicate', run.updated.length === 1 && run.updated[0].id === money?.id && all.filter((r) => r.applies_to.includes('money')).length === 1, JSON.stringify({ updated: run.updated, held: run.held }));
check('it is now decided, starting 1 Mar 2027', after?.stage === 'decided' && after?.dates.decided === '2026-11-11' && after?.dates.in_force === '2027-03-01', JSON.stringify(after?.dates));
check('the proposal date is kept', after?.dates.proposed === '2026-10-02');
check('the record did not grow past its limits', withinLimits(all, '2026-11-13'));
check('history has two short entries', after?.history.length === 2, JSON.stringify(after?.history));
// The second reader is free to hold the notice if it doubts a sentence. What must not happen is ignoring it or mislabelling it.
check('the warning notice is published as guidance for all firms, or held for review', (run.published.length === 1 && warning?.applies_to.join() === 'all') || (run.held.length === 1 && !warning), JSON.stringify({ published: run.published, held: run.held }));
check('the reminder is ignored', run.ignored.length === 1, JSON.stringify(run.ignored));
console.log(`\n--- The notification an admin would get ---\n${await readFile(path.join(root, 'digest.md'), 'utf8')}\n---`);

console.log('\n3. Third run: nothing new on the page');
run = await runAssistant('2026-11-14', 'listing-2.html');
check('every item is skipped as seen before, at no AI cost', run.already_seen === 6 && run.cost_usd === 0 && !run.published.length && !run.updated.length, JSON.stringify({ seen: run.already_seen, cost: run.cost_usd }));

console.log('\n4. An admin reverts the update. A second body then reports the same decision');
admin('revert', money.id, '2026-11-14');
let reverted = (await records()).find((r) => r.id === money.id);
check('the change is back to a proposal, with an admin note', reverted.stage === 'proposed' && reverted.admin_notes.length === 1, JSON.stringify(reverted.admin_notes));
run = await runAssistant('2026-11-15', 'listing-3.html');
reverted = (await records()).find((r) => r.id === money.id);
check('the assistant does not re-apply the reverted update', run.ignored.length === 1 && !run.updated.length && reverted.stage === 'proposed', JSON.stringify({ ignored: run.ignored, updated: run.updated, held: run.held }));
check('no change was added or lost', (await records()).length === all.length);

console.log('\n5. The admin puts the decision in by hand. The start date then arrives');
admin('edit', money.id, '2026-11-16', { stage: 'decided', dates: { proposed: '2026-10-02', decided: '2026-11-11', in_force: '2027-03-01' } });
run = await runAssistant('2027-03-02', 'listing-3.html');
const final = (await records()).find((r) => r.id === money.id);
check('the change moves to in force on its own', final.stage === 'in_force' && final.history.at(-1).event === 'Came into force.' && run.now_in_force.length === 1, JSON.stringify(final.history));
check('all records still within limits', withinLimits(await records(), '2027-03-02'));

console.log(`\nFinal record:\n${JSON.stringify(final, null, 2)}`);
console.log(`\nCommits:\n${git('log', '--format=  %s')}`);
console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll checks passed.');
console.log(`Working folder: ${root}`);
process.exit(failures.length ? 1 : 0);
