// Rehearses whole runs of the assistant with ready-made AI answers and made-up pages. No AI, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const agent = path.join(import.meta.dirname, '..');
const TODAY = '2026-11-16';
const SITE = 'https://reg.test';

const body = (text) => `<html><body><main><h1>${text}</h1><p>${`${text}. `.repeat(30)}</p></main></body></html>`;
const listing = (slugs, next = '') => `<html><body><main>${slugs.map((s) => `<a href="/news/${s}">${s}</a>`).join('')}${next}</main></body></html>`;
const record = (slug, over = {}) => ({
  id: `uk-reg-${slug}`, regulator: 'REG', title: `Rule about ${slug}`, summary: `From a date, firms must do ${slug}.`,
  what_changes: [`Firms must do ${slug}.`], applies_to: ['all'], who_it_applies_to: 'All regulated firms.', topic: 'Other',
  stage: 'proposed', dates: { proposed: '2026-11-10', decided: null, in_force: null, in_force_text: null, published: null }, source_name: 'REG', ...over,
});
const fresh = (slug, published, over) => ({ decision: 'new', reason: 'A new change.', record_id: null, published, history_event: 'Consultation opened.', record: record(slug, over) });
const ignored = { decision: 'ignore', reason: 'Not a change.', record_id: null, published: null, history_event: null, record: null };

// A throwaway tracker: its own sources, pages and AI answers.
function tracker({ sources, pages, answers = {}, checker = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), 'tracker-run-'));
  mkdirSync(path.join(root, 'sources'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'sources', 'uk.json'), JSON.stringify(sources));
  const t = {
    root,
    setPages(map) {
      const index = {};
      Object.entries(map).forEach(([url, html], i) => { index[url] = `p${i}.html`; writeFileSync(path.join(root, 'pages', `p${i}.html`), html); });
      writeFileSync(path.join(root, 'pages', 'index.json'), JSON.stringify(index));
    },
    setAnswers(writer, check = checker) { writeFileSync(path.join(root, 'answers.json'), JSON.stringify({ writer, checker: check })); },
    run(...args) {
      const out = spawnSync('node', [path.join(agent, 'run.mjs'), '--root', root, '--today', TODAY, '--country', 'uk', ...args],
        { encoding: 'utf8', env: { ...process.env, TRACKER_FIXTURES: path.join(root, 'pages'), TRACKER_AI_STUB: path.join(root, 'answers.json') } });
      return { code: out.status, out: out.stdout + out.stderr, log: t.json(`data/log/${TODAY}.json`).at(-1), seen: t.json('data/seen.json') };
    },
    json: (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')),
    has: (file) => existsSync(path.join(root, file)),
  };
  t.setPages(pages);
  t.setAnswers(answers);
  return t;
}
const news = [{ id: 'reg-news', regulator: 'REG', covers: 'news', enabled: true, how: 'page', url: `${SITE}/news/`, match: '^https://reg\\.test/news/.+' }];

test('a run publishes, ignores, holds and sets aside, and a second run reads nothing twice', () => {
  const t = tracker({
    sources: news,
    pages: {
      [`${SITE}/news/`]: listing(['new-rule', 'award', 'old-rule', 'held(rule)', 'broken']),
      [`${SITE}/news/new-rule`]: body('A new rule'), [`${SITE}/news/award`]: body('An award'),
      [`${SITE}/news/old-rule`]: body('An old rule'), [`${SITE}/news/held(rule)`]: body('A doubtful rule'),
    },
    answers: {
      [`${SITE}/news/new-rule`]: fresh('new-rule', '2026-11-10'), [`${SITE}/news/award`]: ignored,
      [`${SITE}/news/old-rule`]: fresh('old-rule', '2026-06-01', { dates: { proposed: '2026-06-01' } }),
      [`${SITE}/news/held(rule)`]: fresh('held-rule', '2026-11-11'),
    },
    checker: { 'uk-reg-held-rule': { pass: false, problems: ['a date is not in the source'], duplicate_of: null } },
  });
  const first = t.run();
  assert.equal(first.code, 0, first.out);
  assert.ok(t.has('data/uk/uk-reg-new-rule.json'), 'the new rule is published');
  assert.equal(first.seen[`${SITE}/news/award`].decision, 'ignored');
  assert.equal(first.seen[`${SITE}/news/old-rule`].too_old, '2026-06-01', 'an old page is remembered as too old');
  assert.ok(!t.has('data/uk/uk-reg-old-rule.json'));
  assert.deepEqual(first.seen[`${SITE}/news/broken`].attempts, 1, 'a page that cannot be read is counted');
  const held = readdirSync(path.join(t.root, 'review'));
  assert.match(held[0], /^2026-11-16-uk-reg-held-rule-[0-9a-f]{6}\.json$/, 'a held item gets a safe, unique file name');
  assert.deepEqual(first.log.countries, ['uk']);
  assert.deepEqual(first.log.sources, [{ id: 'reg-news', country: 'uk', listed: 5, relevant: 5, read: 5 }]);
  assert.equal(first.log.published[0].country, 'uk');
  assert.equal(first.log.ignored[0].source, 'reg-news');

  // Nothing is read twice, except the page that failed. After three tries it is set aside for good.
  t.setAnswers({});
  const second = t.run();
  assert.equal(second.log.source_problems.length, 1, second.out);
  assert.equal(second.seen[`${SITE}/news/broken`].attempts, 2);
  const third = t.run();
  assert.equal(third.seen[`${SITE}/news/broken`].decision, 'ignored');
  assert.match(third.seen[`${SITE}/news/broken`].reason, /set aside after 3 failed tries/);
  assert.equal(t.run().log.source_problems.length, 0, 'a page that was set aside stops coming back');

  // Looking further back brings in the page that was too old.
  t.setAnswers({ [`${SITE}/news/old-rule`]: fresh('old-rule', '2026-06-01', { dates: { proposed: '2026-06-01' } }) });
  t.run('--since', '2026-05-01');
  assert.ok(t.has('data/uk/uk-reg-old-rule.json'), 'a longer look-back reads the old page again');

  // An admin can ask for an ignored page to be added.
  t.setAnswers({ [`${SITE}/news/award`]: fresh('award', '2026-11-12') });
  const asked = t.run('--include', `${SITE}/news/award`);
  assert.equal(asked.code, 0, asked.out);
  assert.ok(t.has('data/uk/uk-reg-award.json'), 'the page the admin asked for is published');
  assert.match(t.run('--include', `${SITE}/news/never-read`).log.stopped_early, /never read/);
});

test('an outage of the AI is not counted against the pages', () => {
  const slugs = ['a', 'b', 'c', 'd'];
  const t = tracker({ sources: news, pages: { [`${SITE}/news/`]: listing(slugs), ...Object.fromEntries(slugs.map((s) => [`${SITE}/news/${s}`, body(`Page ${s}`)])) } });
  const down = t.run();
  assert.equal(down.code, 1);
  assert.match(down.log.stopped_early, /failed three times in a row/);
  assert.deepEqual(Object.keys(down.seen), [], 'no page is marked as failed');
});

test('a run that is out of time stops cleanly and says so', () => {
  const t = tracker({ sources: news, pages: { [`${SITE}/news/`]: listing(['x']), [`${SITE}/news/x`]: body('Page x') }, answers: { [`${SITE}/news/x`]: ignored } });
  const out = t.run('--max-minutes', '0');
  assert.equal(out.code, 0, out.out);
  assert.match(out.log.stopped_early, /Time limit reached/);
  assert.deepEqual(out.seen, {});
  assert.equal(t.run().seen[`${SITE}/news/x`].decision, 'ignored', 'the next run carries on');
});

test('a look further back follows the listing to its older pages', () => {
  const t = tracker({
    sources: news,
    pages: {
      [`${SITE}/news/`]: listing(['one'], '<a rel="next" href="?page=2">Next</a>'),
      [`${SITE}/news/?page=2`]: listing(['two']),
      [`${SITE}/news/one`]: body('Page one'), [`${SITE}/news/two`]: body('Page two'),
    },
    answers: { [`${SITE}/news/one`]: ignored, [`${SITE}/news/two`]: ignored },
  });
  assert.deepEqual(Object.keys(t.run().seen), [`${SITE}/news/one`]);
  assert.deepEqual(Object.keys(t.run('--pages', '3').seen).sort(), [`${SITE}/news/one`, `${SITE}/news/two`]);
});

test('a page listed again with a later date is read again, but only if its words changed', () => {
  const feed = (date) => `<?xml version="1.0"?><feed><entry><title>Notice</title><link href="${SITE}/notice"/><updated>${date}T09:00:00Z</updated></entry></feed>`;
  const t = tracker({
    sources: [{ id: 'reg-feed', regulator: 'REG', covers: 'feed', enabled: true, how: 'feed', url: `${SITE}/feed` }],
    pages: { [`${SITE}/feed`]: feed('2026-11-01'), [`${SITE}/notice`]: body('The first version') },
    answers: { [`${SITE}/notice`]: ignored },
  });
  assert.equal(t.run().seen[`${SITE}/notice`].listed, '2026-11-01');

  // Same words, later date: no AI call (there is no answer ready, so a call would show up as a problem).
  t.setPages({ [`${SITE}/feed`]: feed('2026-11-12'), [`${SITE}/notice`]: body('The first version') });
  t.setAnswers({});
  const same = t.run();
  assert.equal(same.log.source_problems.length, 0, same.out);
  assert.equal(same.seen[`${SITE}/notice`].listed, '2026-11-12');

  // New words, later date: it is read again and can now become a change.
  t.setPages({ [`${SITE}/feed`]: feed('2026-11-14'), [`${SITE}/notice`]: body('The second version') });
  t.setAnswers({ [`${SITE}/notice`]: fresh('notice', '2026-11-01') });
  const changed = t.run();
  assert.ok(t.has('data/uk/uk-reg-notice.json'), changed.out);
  assert.equal(t.json('data/uk/uk-reg-notice.json').history[0].date, '2026-11-14', 'the history line carries the date of this version');
});

test('a change starts on its start date, after the day\'s sources have been read', () => {
  const t = tracker({ sources: news, pages: { [`${SITE}/news/`]: listing([]) } });
  const decided = { ...record('starts-today', { stage: 'decided', dates: { proposed: '2026-01-10', decided: '2026-06-01', in_force: TODAY } }),
    country: 'uk', status: 'live', source: { name: 'REG', url: `${SITE}/news/starts-today` }, last_checked: '2026-06-01', history: [], admin_notes: [] };
  delete decided.source_name;
  mkdirSync(path.join(t.root, 'data', 'uk'), { recursive: true });
  writeFileSync(path.join(t.root, 'data', 'uk', 'uk-reg-starts-today.json'), JSON.stringify(decided));
  const out = t.run();
  assert.equal(t.json('data/uk/uk-reg-starts-today.json').stage, 'in_force', out.out);
  assert.equal(out.log.now_in_force[0].country, 'uk');
});

test('undoing an undo is refused', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tracker-admin-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const admin = (...a) => spawnSync('node', [path.join(agent, 'admin.mjs'), ...a, '--root', root, '--commit'], { encoding: 'utf8' });
  const file = path.join(root, 'data', 'uk', 'uk-reg-thing.json');
  const rec = { ...record('thing'), country: 'uk', status: 'live', source: { name: 'REG', url: `${SITE}/thing` }, last_checked: TODAY,
    history: [{ date: '2026-11-10', event: 'Consultation opened.', url: `${SITE}/thing` }], admin_notes: [] };
  delete rec.source_name;
  rec.dates = { proposed: '2026-11-10' };
  mkdirSync(path.dirname(file), { recursive: true });
  git('init', '-q'); git('config', 'user.name', 't'); git('config', 'user.email', 't@example.test');
  writeFileSync(file, JSON.stringify(rec)); git('add', '-A'); git('commit', '-q', '-m', 'New');
  writeFileSync(file, JSON.stringify({ ...rec, summary: 'A worse summary.', history: [...rec.history, { date: TODAY, event: 'Bad update.', url: `${SITE}/bad` }] }));
  git('add', '-A'); git('commit', '-q', '-m', 'Update');

  assert.equal(admin('revert', 'uk-reg-thing').status, 0);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.summary, rec.summary);
  assert.match(after.admin_notes[0], /Do not apply it again/);
  const again = admin('revert', 'uk-reg-thing');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already an undo/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).summary, rec.summary, 'the bad update does not come back');
});
