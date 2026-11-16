#!/usr/bin/env node
// The daily run. For each source: list what is new, decide what each item is,
// check it in code and with a second independent reader, then publish or hold it.
//
//   node agent/run.mjs [--commit] [--recheck] [--country uk] [--source sra-news]
//                      [--since YYYY-MM-DD] [--today YYYY-MM-DD] [--root DIR]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from './lib/store.mjs';
import { listCandidates, fetchPageText, normaliseUrl, hash } from './lib/web.mjs';
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

const run = { date: today, since, published: [], updated: [], now_in_force: [], held: [], ignored: [], due_check: [], source_problems: [], already_seen: 0, cost_usd: 0, stopped_early: null };
const seen = await store.loadSeen();
let failuresInARow = 0;

const prompts = {
  writer: await readFile(path.join(agentDir, 'instructions.md'), 'utf8'),
  checker: await readFile(path.join(agentDir, 'verifier.md'), 'utf8'),
};

try {
  for (const country of countries) {
    const sources = (await store.loadSources(country)).filter((s) => s.enabled && (!args.source || s.id === args.source));
    if (!sources.length) continue;
    const records = await store.loadRecords(country);

    await startDueChanges(records);

    for (const source of sources) {
      let items;
      try {
        items = await listCandidates(source);
      } catch (error) {
        run.source_problems.push({ source: source.id, url: source.url ?? source.organisation, problem: error.message });
        continue;
      }
      const inWindow = items.filter((i) => !i.date || i.date >= since);
      const fresh = inWindow.filter((i) => !seen[normaliseUrl(i.url)]);
      run.already_seen += inWindow.length - fresh.length;
      // Oldest first, so a proposal is recorded before the decision on it.
      const batch = fresh.slice(0, cfg.max_items_per_source).reverse();
      if (batch.every((i) => i.date)) batch.sort((a, b) => a.date.localeCompare(b.date));
      for (const item of batch) await handle(item, source, country, records);
    }

    if (args.recheck) await recheckOpenChanges(country, records);
  }
} catch (error) {
  // Stop early, but still save what was done and report it.
  run.stopped_early = error.message;
  process.exitCode = 1;
}

await finish();

// ---------------------------------------------------------------------------

async function handle(item, source, country, records, { isRecheck = false } = {}) {
  const url = normaliseUrl(item.url);
  let text;
  try {
    text = await fetchPageText(item.url);
  } catch (error) {
    run.source_problems.push({ source: source.id, url, problem: error.message });
    return;
  }
  const remember = (entry) => { seen[url] = { ...entry, date: today, source: source.id, hash: hash(text) }; };
  const ignore = (reason) => {
    remember({ decision: 'ignored', reason });
    if (!isRecheck) run.ignored.push({ title: item.title, url, reason });
  };

  let out;
  let record;
  let prev = null;
  let problems = [];
  try {
    // The writer gets one chance to fix a draft that breaks the rules.
    for (let attempt = 0; attempt < 2; attempt++) {
      out = await writer({ country, source, item, text, records, feedback: attempt ? problems : null });
      if (out.decision === 'ignore' || !out.record) break;
      prev = out.decision === 'update' ? records.find((r) => r.id === out.record_id) ?? null : null;
      if (out.decision === 'update' && !prev) {
        problems = [`there is no existing change with id "${out.record_id}"`];
        continue;
      }
      record = buildRecord(out, prev, item, country);
      problems = [...validateRecord(record, cfg, today), ...(prev ? validateUpdate(prev, record) : []), ...historyProblems(out)];
      if (!problems.length) break;
    }
  } catch (error) {
    return aiFailed(item, url, error);
  }
  failuresInARow = 0;

  if (out.decision === 'ignore' || !out.record) return ignore(out.reason);
  if (problems.length) return hold({ item, url, source, record, prev, reasons: problems, remember });

  // When the page shows no publication date, fall back to the date the change reached its stage.
  const stageDate = record.dates[STAGE_DATE[record.stage]];
  const itemDate = validDate(out.published) ?? item.date ?? (stageDate ? periodStart(stageDate) : null);
  if (out.decision === 'new') {
    if (isRecheck) return ignore('a re-check cannot create a new change');
    if (itemDate && itemDate < since) return ignore(`published ${itemDate}, before the look-back date ${since}`);
    const duplicate = findDuplicate(record, records);
    if (duplicate) return hold({ item, url, source, record, prev, reasons: [`possible duplicate of ${duplicate.id}: ${duplicate.why}`], remember });
  } else if (!isMaterialChange(prev, record)) {
    return ignore('no fact changed; rewording alone is not an update');
  }

  let verdict;
  try {
    verdict = await checker({ country, text, record, prev, records });
  } catch (error) {
    return aiFailed(item, url, error);
  }
  failuresInARow = 0;
  if (!verdict.pass || verdict.duplicate_of) {
    const reasons = [...verdict.problems, ...(verdict.duplicate_of ? [`duplicate of ${verdict.duplicate_of}`] : [])];
    return hold({ item, url, source, record, prev, reasons: reasons.length ? reasons : ['the checker did not pass it'], remember });
  }

  const file = await store.saveRecord(record);
  if (prev) records[records.indexOf(prev)] = record;
  else records.push(record);
  remember({ decision: prev ? 'updated' : 'new', record_id: record.id });
  const entry = { id: record.id, title: record.title, regulator: record.regulator, stage: record.stage, source: url, summary: record.summary };
  if (prev) run.updated.push({ ...entry, what_changed: describeUpdate(prev, record), event: out.history_event });
  else run.published.push(entry);
  if (args.commit) store.commit([file], `${prev ? 'Update' : 'New'}: ${record.title}`, `${record.id}\n${url}`);
}

async function writer({ country, source, item, text, records, feedback }) {
  const prompt = [
    `Today is ${today}. Country: ${country}.`,
    `<existing_changes>\n${JSON.stringify(records.map(forWriter), null, 1)}\n</existing_changes>`,
    `<item>\nsource: ${source.regulator} (${source.covers})\nurl: ${item.url}\nlisted_title: ${item.title || 'not given'}\nlisted_date: ${item.date ?? 'not given'}\n<page_text>\n${text}\n</page_text>\n</item>`,
    feedback ? `<fix>\nYour previous answer was rejected for the reasons below. Answer again and fix every one.\n- ${feedback.join('\n- ')}\n</fix>` : '',
  ].filter(Boolean).join('\n\n');
  const { data, cost } = await ask({ system: `${prompts.writer}\n\n${allowedValues(country)}`, prompt, schema: WRITER_ANSWER, model: cfg.model });
  run.cost_usd += cost;
  return data;
}

async function checker({ country, text, record, prev, records }) {
  const others = records.filter((r) => r.id !== record.id)
    .map((r) => ({ id: r.id, status: r.status, regulator: r.regulator, title: r.title, summary: r.summary, stage: r.stage }));
  const prompt = [
    `Today is ${today}. Country: ${country}.`,
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
  const event = { date: validDate(out.published) ?? item.date ?? today, event: (out.history_event ?? '').trim(), url: normaliseUrl(item.url) };
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

async function hold({ item, url, source, record, prev, reasons, remember }) {
  const name = `${today}-${(record?.id ?? new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'item').slice(0, 60)}`;
  const file = await store.addToReview(name, {
    held_on: today,
    reasons,
    item: { title: item.title, url, source: source.id },
    would_be: prev ? 'update' : 'new',
    proposed_record: record ?? null,
    current_record: prev,
  });
  remember({ decision: 'held', review_file: path.relative(store.root, file) });
  run.held.push({ title: record?.title ?? item.title, url, reasons, review_file: path.relative(store.root, file) });
}

function aiFailed(item, url, error) {
  // Not remembered, so the item is tried again on the next run.
  run.source_problems.push({ source: 'assistant', url, problem: error.message });
  if (++failuresInARow >= 3) throw new Error(`The AI failed three times in a row. Last error: ${error.message}`);
}

// A decided change whose exact start date has arrived is now in force. No AI needed.
async function startDueChanges(records) {
  for (const rec of records) {
    if (rec.status !== 'live' || rec.stage !== 'decided' || !rec.dates.in_force) continue;
    const start = rec.dates.in_force;
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && start <= today) {
      rec.stage = 'in_force';
      rec.last_checked = today;
      rec.history = [...rec.history, { date: start, event: 'Came into force.', url: rec.source.url }].slice(-cfg.limits.history_max_items);
      const file = await store.saveRecord(rec);
      run.now_in_force.push({ id: rec.id, title: rec.title, date: start });
      if (args.commit) store.commit([file], `In force: ${rec.title}`, rec.id);
    } else if (start.length < 10 && periodStart(start) <= today) {
      run.due_check.push({ id: rec.id, title: rec.title, expected: rec.dates.in_force_text ?? start });
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
      run.source_problems.push({ source: `recheck ${rec.id}`, url, problem: error.message });
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
  lines.push(`To undo or remove a change, run the "Admin action" workflow with the command shown. Ignored: ${run.ignored.length}. Seen before: ${run.already_seen}.`);
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

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today ? value : null;
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
