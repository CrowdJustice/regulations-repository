#!/usr/bin/env node
// The daily run. For each source: list what is new, decide what each item is,
// check it in code and with a second independent reader, then publish or hold it.
//
//   node agent/run.mjs [--commit] [--recheck] [--country uk] [--source sra-news]
//                      [--since YYYY-MM-DD] [--today YYYY-MM-DD] [--root DIR]
//                      [--pages N] [--max-items N] [--max-minutes N] [--include URL]
//
//   --pages        also read this many older listing pages per source, for a look further back
//   --max-items    how many pages to read per source in one run (default: max_items_per_source in config.json)
//   --max-minutes  stop taking new pages after this long; the next run carries on where this one stopped
//   --include      an admin asked for this one page, which the assistant had ignored, to be added

import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './lib/store.mjs';
import { newItems, fetchPageText, normaliseUrl, hash } from './lib/web.mjs';
import { ask } from './lib/llm.mjs';
import { WRITER_ANSWER, CHECKER_ANSWER } from './lib/answers.mjs';
import { validateRecord, validateUpdate, isMaterialChange, findDuplicate, periodStart, STAGES, STAGE_DATE } from './lib/checks.mjs';

const agentDir = import.meta.dirname;
const args = parseArgs(process.argv.slice(2));
const cfg = JSON.parse(await readFile(path.join(agentDir, 'config.json'), 'utf8'));
const store = createStore(path.resolve(args.root ?? path.join(agentDir, '..')));
const today = args.today ?? new Date().toISOString().slice(0, 10);
const since = args.since ?? addDays(today, -cfg.window_days);
const countries = args.country ? [args.country] : Object.keys(cfg.applies_to);
// The date where the country is. A page dated this morning in Sydney is not "in the future" because it is still yesterday in UTC.
const todayIn = (country) => args.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: cfg.countries[country]?.timezone ?? 'UTC' }).format(new Date());
const pages = Math.max(1, Number(args.pages ?? 1));
const maxItems = Math.max(1, Number(args['max-items'] ?? cfg.max_items_per_source));
const deadline = args['max-minutes'] ? Date.now() + Number(args['max-minutes']) * 60000 : Infinity;
const TIME_LIMIT = 'Time limit reached. The next run carries on from here.';

const run = { date: today, since, countries: [], sources: [], published: [], updated: [], now_in_force: [], held: [], ignored: [], due_check: [], source_problems: [], already_seen: 0, cost_usd: 0, stopped_early: null };
const seen = await store.loadSeen();
const sourcesOf = {};
for (const country of countries) sourcesOf[country] = (await store.loadSources(country)).filter((s) => s.enabled && (!args.source || s.id === args.source));
// A page skipped only for being older than the look-back is read again when the look-back reaches it.
const inPlay = new Set(Object.values(sourcesOf).flat().map((s) => s.id));
for (const [url, entry] of Object.entries(seen)) if (entry.too_old && entry.too_old >= since && inPlay.has(entry.source)) delete seen[url];
let failuresInARow = 0;
// What the seen-before list said about each page the AI has just failed on, so an outage of the AI is not counted against the pages.
let aiFailures = [];

const prompts = {
  writer: await readFile(path.join(agentDir, 'instructions.md'), 'utf8'),
  checker: await readFile(path.join(agentDir, 'verifier.md'), 'utf8'),
};

try {
  if (args.include) await includePage(args.include);
  else {
    for (const country of countries) {
      const sources = sourcesOf[country];
      if (!sources.length) continue;
      run.countries.push(country);
      const records = await store.loadRecords(country);

      for (const source of sources) {
        let found;
        try {
          found = await newItems(source, { seen, since, max: maxItems, pages });
        } catch (error) {
          run.source_problems.push({ source: source.id, country, url: source.url ?? source.organisation, problem: error.message });
          continue;
        }
        run.sources.push({ id: source.id, country, listed: found.listed, relevant: found.matched, read: found.batch.length });
        run.already_seen += found.inWindow - found.fresh;
        for (const item of found.batch) {
          if (Date.now() > deadline) throw new Error(TIME_LIMIT);
          await handle(item, source, country, records);
        }
        // Saved as it goes, so a run that is cut off does not read the same pages again.
        await store.saveSeen(seen);
      }

      if (args.recheck) await recheckOpenChanges(country, records);
    }
  }
} catch (error) {
  // Stop early, but still save what was done and report it. Running out of time is not a failure.
  run.stopped_early = error.message;
  if (error.message !== TIME_LIMIT) process.exitCode = 1;
}

// After the sources are read, so news that a start date has moved gets in before the change is marked as started.
if (!args.include) for (const country of countries) await startDueChanges(await store.loadRecords(country), country);

await finish();

// ---------------------------------------------------------------------------

async function handle(item, source, country, records, { isRecheck = false, requested = false } = {}) {
  const url = normaliseUrl(item.url);
  const day = todayIn(country);
  let text;
  try {
    text = await fetchPageText(item.url);
  } catch (error) {
    if (!isRecheck) countFailure(item, url, source, country, error.message);
    run.source_problems.push({ source: source.id, country, url, problem: error.message });
    return;
  }
  const before = seen[url];
  // A listing can show a page again because its date moved. If the words are the same, there is nothing to do.
  if (!isRecheck && !requested && before && before.decision !== 'failed' && before.hash === hash(text)) {
    seen[url] = { ...before, ...(item.date ? { listed: item.date } : {}) };
    return;
  }
  const remember = (entry) => { seen[url] = { ...entry, date: today, source: source.id, hash: hash(text), ...(item.date ? { listed: item.date } : {}) }; };
  const ignore = (reason, extra = {}) => {
    remember({ decision: 'ignored', reason, ...extra });
    if (!isRecheck) run.ignored.push({ title: item.title, url, reason, country, source: source.id });
  };

  let out;
  let record;
  let prev = null;
  let problems = [];
  try {
    // The writer gets one chance to fix a draft that breaks the rules.
    for (let attempt = 0; attempt < 2; attempt++) {
      out = await writer({ country, day, source, item, text, records, requested, feedback: attempt ? problems : null });
      if (out.decision === 'ignore' || !out.record) break;
      prev = out.decision === 'update' ? records.find((r) => r.id === out.record_id) ?? null : null;
      if (out.decision === 'update' && !prev) {
        problems = [`there is no existing change with id "${out.record_id}"`];
        continue;
      }
      record = buildRecord(out, prev, item, country);
      problems = [...validateRecord(record, cfg, day), ...(prev ? validateUpdate(prev, record) : []), ...historyProblems(out)];
      if (!problems.length) break;
    }
  } catch (error) {
    return aiFailed(item, url, source, country, error, isRecheck);
  }
  aiWorked();

  if (out.decision === 'ignore' || !out.record) return ignore(out.reason);
  if (problems.length) return hold({ item, url, source, country, record, prev, reasons: problems, remember });

  if (out.decision === 'new') {
    if (isRecheck) return ignore('a re-check cannot create a new change');
    // The look-back rule, for listings that show no dates (a dated listing was filtered before the page was read).
    // The page's own date is used, or failing that the exact date the change reached its stage.
    const stageDate = record.dates[STAGE_DATE[record.stage]];
    const pageDate = validDate(out.published, day) ?? (/^\d{4}-\d{2}-\d{2}$/.test(stageDate ?? '') ? stageDate : null);
    if (!requested && !item.date && pageDate && pageDate < since) return ignore(`published ${pageDate}, before the look-back date ${since}`, { too_old: pageDate });
    const duplicate = findDuplicate(record, records);
    if (duplicate) return hold({ item, url, source, country, record, prev, reasons: [`possible duplicate of ${duplicate.id}: ${duplicate.why}`], remember });
  } else if (!isMaterialChange(prev, record)) {
    return ignore('no fact changed; rewording alone is not an update');
  }

  let verdict;
  try {
    verdict = await checker({ country, day, text, record, prev, records });
  } catch (error) {
    return aiFailed(item, url, source, country, error, isRecheck);
  }
  aiWorked();
  if (!verdict.pass || verdict.duplicate_of) {
    const reasons = [...verdict.problems, ...(verdict.duplicate_of ? [`duplicate of ${verdict.duplicate_of}`] : [])];
    return hold({ item, url, source, country, record, prev, reasons: reasons.length ? reasons : ['the checker did not pass it'], remember });
  }

  const file = await store.saveRecord(record);
  if (prev) records[records.indexOf(prev)] = record;
  else records.push(record);
  remember({ decision: prev ? 'updated' : 'new', record_id: record.id });
  const entry = { id: record.id, country, title: record.title, regulator: record.regulator, stage: record.stage, source: url, summary: record.summary };
  if (prev) run.updated.push({ ...entry, what_changed: describeUpdate(prev, record), event: out.history_event });
  else run.published.push(entry);
  if (args.commit) store.commit([file], `${prev ? 'Update' : 'New'}: ${record.title}`, `${record.id}\n${url}`);
}

async function writer({ country, day, source, item, text, records, requested, feedback }) {
  const prompt = [
    `Today is ${day}. Country: ${country}.`,
    `<existing_changes>\n${JSON.stringify(records.map(forWriter), null, 1)}\n</existing_changes>`,
    `<item>\nsource: ${source.regulator} (${source.covers})\nurl: ${item.url}\nlisted_title: ${item.title || 'not given'}\nlisted_date: ${item.date ?? 'not given'}\n<page_text>\n${text}\n</page_text>\n</item>`,
    requested ? '<admin_request>\nAn admin has read this page and asked for it to be on the tracker. Choose `new`, or `update` if the tracker already holds the change. Choose `ignore` only if the page has nothing to do with rules or guidance for law firms. Every other rule still applies.\n</admin_request>' : '',
    feedback ? `<fix>\nYour previous answer was rejected for the reasons below. Answer again and fix every one.\n- ${feedback.join('\n- ')}\n</fix>` : '',
  ].filter(Boolean).join('\n\n');
  const { data, cost } = await ask({ system: `${prompts.writer}\n\n${allowedValues(country)}`, prompt, schema: WRITER_ANSWER, model: cfg.model });
  run.cost_usd += cost;
  return data;
}

async function checker({ country, day, text, record, prev, records }) {
  const others = records.filter((r) => r.id !== record.id)
    .map((r) => ({ id: r.id, status: r.status, regulator: r.regulator, title: r.title, summary: r.summary, stage: r.stage }));
  const prompt = [
    `Today is ${day}. Country: ${country}.`,
    `<source_text>\n${text}\n</source_text>`,
    `<proposed_record>\n${JSON.stringify(contentOf(record), null, 1)}\n</proposed_record>`,
    `<previous_version>\n${prev ? JSON.stringify(contentOf(prev), null, 1) : 'none: this is a new record'}\n</previous_version>`,
    `<other_changes>\n${JSON.stringify(others, null, 1)}\n</other_changes>`,
  ].join('\n\n');
  const { data, cost } = await ask({ system: `${prompts.checker}\n\n${allowedValues(country)}`, prompt, schema: CHECKER_ANSWER, model: cfg.model });
  run.cost_usd += cost;
  return data;
}

function buildRecord(out, prev, item, country) {
  const r = out.record;
  const dates = {};
  for (const key of ['proposed', 'decided', 'in_force', 'in_force_text', 'published']) if (r.dates?.[key]) dates[key] = r.dates[key];
  // A listing's own date is the date of this version of the page; the page may also show when it was first published.
  const event = { date: item.date ?? validDate(out.published, todayIn(country)) ?? today, event: (out.history_event ?? '').trim(), url: normaliseUrl(item.url) };
  return {
    id: prev ? prev.id : r.id,
    country,
    status: 'live',
    regulator: prev ? prev.regulator : r.regulator.trim(),
    title: r.title.trim(),
    summary: r.summary.trim(),
    what_changes: r.what_changes.map((point) => point.trim()),
    applies_to: r.applies_to,
    who_it_applies_to: r.who_it_applies_to.trim(),
    topic: r.topic,
    stage: r.stage,
    dates,
    // The link goes to the page for the current stage.
    source: prev && prev.stage === r.stage ? prev.source : { name: r.source_name.trim(), url: normaliseUrl(item.url) },
    last_checked: today,
    history: [...(prev?.history ?? []), event].slice(-cfg.limits.history_max_items),
    admin_notes: prev?.admin_notes ?? [],
  };
}

function historyProblems(out) {
  const event = (out.history_event ?? '').trim();
  if (!event) return ['history_event is missing'];
  if (event.length > cfg.limits.history_event) return [`history_event is ${event.length} characters; the limit is ${cfg.limits.history_event}`];
  return [];
}

async function hold({ item, url, source, country, record, prev, reasons, remember }) {
  // Safe as a file name, and never the same for two different pages.
  const label = String(record?.id ?? new URL(url).pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'item';
  const name = `${today}-${label}-${hash(url).slice(0, 6)}`;
  const file = await store.addToReview(name, {
    held_on: today,
    reasons,
    item: { title: item.title, url, source: source.id },
    would_be: prev ? 'update' : 'new',
    proposed_record: record ?? null,
    current_record: prev,
  });
  remember({ decision: 'held', review_file: path.relative(store.root, file) });
  run.held.push({ title: record?.title ?? item.title, url, reasons, country, source: source.id, review_file: path.relative(store.root, file) });
}

// One page an admin asked for, after the assistant had ignored it. It skips the look-back rule; every other check still applies.
async function includePage(address) {
  const url = normaliseUrl(address);
  const before = seen[url];
  if (!before) throw new Error(`The assistant has never read ${url}, so it cannot be added this way.`);
  if (before.decision !== 'ignored') throw new Error(`${url} was not ignored: its last decision was "${before.decision}".`);
  for (const country of countries) {
    const source = (await store.loadSources(country)).find((s) => s.id === before.source);
    if (!source) continue;
    run.countries.push(country);
    const records = await store.loadRecords(country);
    delete seen[url];
    await handle({ url, title: '', date: null }, source, country, records, { requested: true });
    // If it could not be read this time, keep remembering it as it was.
    if (!seen[url] || seen[url].decision === 'failed') seen[url] = before;
    return;
  }
  throw new Error(`The source this page came from ("${before.source}") no longer exists.`);
}

// A page that cannot be read or processed is tried again on the next two runs, then set aside so it stops coming back.
function countFailure(item, url, source, country, problem) {
  const attempts = (seen[url]?.decision === 'failed' ? seen[url].attempts : 0) + 1;
  if (attempts < 3) seen[url] = { decision: 'failed', attempts, problem, date: today, source: source.id };
  else {
    seen[url] = { decision: 'ignored', reason: `set aside after ${attempts} failed tries: ${problem}`, date: today, source: source.id };
    run.ignored.push({ title: item.title, url, reason: seen[url].reason, country, source: source.id });
  }
}

function aiFailed(item, url, source, country, error, isRecheck) {
  if (!isRecheck) {
    aiFailures.push([url, seen[url]]);
    countFailure(item, url, source, country, error.message);
  }
  run.source_problems.push({ source: 'assistant', country, url, problem: error.message });
  if (++failuresInARow >= 3) {
    // Three in a row means the AI itself is down. That is not the pages' fault, so their counts are put back.
    for (const [failedUrl, before] of aiFailures) { if (before) seen[failedUrl] = before; else delete seen[failedUrl]; }
    throw new Error(`The AI failed three times in a row. Last error: ${error.message}`);
  }
}

function aiWorked() {
  failuresInARow = 0;
  aiFailures = [];
}

// A decided change whose exact start date has arrived is now in force. No AI needed.
async function startDueChanges(records, country) {
  const day = todayIn(country);
  for (const rec of records) {
    if (rec.status !== 'live' || rec.stage !== 'decided' || !rec.dates.in_force) continue;
    const start = rec.dates.in_force;
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && start <= day) {
      rec.stage = 'in_force';
      rec.last_checked = today;
      rec.history = [...rec.history, { date: start, event: 'Came into force.', url: rec.source.url }].slice(-cfg.limits.history_max_items);
      const file = await store.saveRecord(rec);
      run.now_in_force.push({ id: rec.id, country: rec.country, title: rec.title, date: start });
      if (args.commit) store.commit([file], `In force: ${rec.title}`, rec.id);
    } else if (start.length < 10 && (periodStart(start) === day || (args.recheck && periodStart(start) <= day))) {
      // A loose start date ("2027") cannot be acted on automatically. The admin is told on the day and then weekly.
      run.due_check.push({ id: rec.id, country: rec.country, title: rec.title, expected: rec.dates.in_force_text ?? start });
    }
  }
}

// Re-read the source page of every change that is still moving. If the page changed, treat it as a new item.
async function recheckOpenChanges(country, records) {
  const open = records.filter((r) => r.status === 'live' && ['proposed', 'decided'].includes(r.stage));
  for (const rec of open) {
    const url = normaliseUrl(rec.source.url);
    let text;
    try {
      text = await fetchPageText(url);
    } catch (error) {
      run.source_problems.push({ source: `recheck ${rec.id}`, country, url, problem: error.message });
      continue;
    }
    if (seen[url]?.hash === hash(text)) continue;
    const source = { id: `recheck ${rec.id}`, regulator: rec.regulator, covers: 'a re-read of the source page for an existing change' };
    await handle({ url, title: rec.title, date: null }, source, country, records, { isRecheck: true });
  }
}

async function finish() {
  run.cost_usd = Math.round(run.cost_usd * 100) / 100;
  await store.saveSeen(seen);
  await store.appendLog(today, { ...run, finished_at: new Date().toISOString() });
  const digest = buildDigest();
  await writeFile(path.join(store.root, 'digest.md'), digest ?? '');
  if (args.commit) {
    store.commit(['data', 'review'], `Run ${today}: ${run.published.length} new, ${run.updated.length} updated, ${run.held.length} held, ${run.ignored.length} ignored`);
  }
  // Tells the workflow that a look further back ran out of time and should be started again.
  if (run.stopped_early === TIME_LIMIT && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'more=true\n');
  console.log(`${today}: ${run.published.length} new, ${run.updated.length} updated, ${run.now_in_force.length} now in force, ` +
    `${run.held.length} held, ${run.ignored.length} ignored, ${run.already_seen} seen before, ` +
    `${run.source_problems.length} problems, $${run.cost_usd}`);
}

// The notification. Empty when nothing happened.
function buildDigest() {
  const nothing = !run.published.length && !run.updated.length && !run.now_in_force.length && !run.held.length && !run.due_check.length && !run.source_problems.length && !run.stopped_early;
  if (nothing) return null;
  const stage = (s) => ({ proposed: 'Proposed', decided: 'Decided', in_force: 'In force', guidance: 'Guidance' }[s]);
  const lines = [];
  const section = (title, rows) => { if (rows.length) lines.push(`## ${title}`, '', ...rows, ''); };
  section(`New (${run.published.length})`, run.published.map((c) =>
    `- **${c.title}**. ${c.regulator}, ${stage(c.stage)}. [Source](${c.source})\n  ${c.summary}\n  To remove it: \`archive ${c.id}\``));
  section(`Updated (${run.updated.length})`, run.updated.map((c) =>
    `- **${c.title}**. ${c.event} [Source](${c.source})\n  Changed: ${c.what_changed.join('; ')}.\n  To undo it: \`revert ${c.id}\``));
  section(`Now in force (${run.now_in_force.length})`, run.now_in_force.map((c) => `- **${c.title}**, from ${c.date}.`));
  section(`Held for review, not published (${run.held.length})`, run.held.map((c) =>
    `- **${c.title}**. [Source](${c.url})\n  Why: ${c.reasons.join('; ')}\n  File: \`${c.review_file}\``));
  section('Start date may have arrived', run.due_check.map((c) => `- **${c.title}** was expected ${c.expected}. Its stage is still "Decided".`));
  section('Problems', [
    ...(run.stopped_early ? [`- The run stopped early: ${run.stopped_early}`] : []),
    ...run.source_problems.map((p) => `- ${p.source}: ${p.problem} (${p.url})`),
  ]);
  // On GitHub the repository names itself, so moving or renaming it needs no change here.
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? cfg.repo).split('/');
  const adminPage = `${cfg.site_url ?? `https://${owner.toLowerCase()}.github.io/${name}/`}admin.html`;
  lines.push(`To publish, undo or remove anything, open the [admin page](${adminPage}). Ignored: ${run.ignored.length}. Seen before: ${run.already_seen}.`);
  return lines.join('\n');
}

function describeUpdate(prev, next) {
  const label = { proposed: 'Proposed', decided: 'Decided', in_force: 'In force', guidance: 'Guidance' };
  const changed = [];
  if (prev.stage !== next.stage) changed.push(`stage ${label[prev.stage]} → ${label[next.stage]}`);
  for (const key of ['proposed', 'decided', 'in_force', 'in_force_text', 'published']) {
    if ((prev.dates[key] ?? null) !== (next.dates[key] ?? null)) changed.push(`${key.replaceAll('_', ' ')} date ${prev.dates[key] ?? 'not set'} → ${next.dates[key] ?? 'not set'}`);
  }
  if (JSON.stringify([...prev.applies_to].sort()) !== JSON.stringify([...next.applies_to].sort())) changed.push('who it applies to');
  for (const key of ['title', 'summary', 'what_changes', 'who_it_applies_to']) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) changed.push(`${key.replaceAll('_', ' ')} reworded`);
  }
  return changed;
}

function allowedValues(country) {
  const lim = cfg.limits;
  const keys = Object.entries(cfg.applies_to[country]).map(([key, v]) => `  - \`${key}\`: ${v.means}`).join('\n');
  return [
    '## Limits and allowed values',
    '',
    `- title: ${lim.title} characters at most`,
    `- summary: ${lim.summary} characters at most`,
    `- what_changes: ${lim.what_changes_max_items} points at most, each ${lim.what_changes_item} characters at most`,
    `- who_it_applies_to: ${lim.who_it_applies_to} characters at most`,
    `- history_event: ${lim.history_event} characters at most`,
    `- in_force_text: ${lim.in_force_text} characters at most`,
    `- topic, one of: ${cfg.topics.join('; ')}`,
    `- stage, one of: ${STAGES.join(', ')}`,
    `- applies_to keys for ${country}:`,
    keys,
  ].join('\n');
}

function forWriter(r) {
  return {
    id: r.id, status: r.status, regulator: r.regulator, title: r.title, summary: r.summary, what_changes: r.what_changes,
    applies_to: r.applies_to, who_it_applies_to: r.who_it_applies_to, topic: r.topic, stage: r.stage, dates: r.dates,
    source_url: r.source.url, recent_history: r.history.slice(-3).map((h) => `${h.date}: ${h.event}`), admin_notes: r.admin_notes,
  };
}

function contentOf(r) {
  const { id, regulator, title, summary, what_changes, applies_to, who_it_applies_to, topic, stage, dates } = r;
  return { id, regulator, title, summary, what_changes, applies_to, who_it_applies_to, topic, stage, dates };
}

function validDate(value, day = today) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= day ? value : null;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['commit', 'recheck'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}
