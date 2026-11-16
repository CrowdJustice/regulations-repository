import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRecord, validateUpdate, isMaterialChange, findDuplicate, titleSimilarity } from '../lib/checks.mjs';

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const today = '2026-11-16';

const good = () => ({
  id: 'uk-sra-client-money-reports',
  country: 'uk',
  status: 'live',
  regulator: 'SRA',
  title: 'Annual accountants’ reports for every firm holding client money',
  summary: 'From early 2027, every firm that holds client money must file an accountants’ report each year.',
  what_changes: ['An accountants’ report and firm declaration every year.', 'Fixed penalties for late reports.'],
  applies_to: ['money'],
  who_it_applies_to: 'All SRA-regulated firms that hold client money.',
  topic: 'Client money',
  stage: 'decided',
  dates: { proposed: '2024-11', decided: '2026-07-31', in_force: '2027-01', in_force_text: 'Early 2027' },
  source: { name: 'SRA', url: 'https://www.sra.org.uk/news/news/press/safeguards-protect-client-money' },
  last_checked: today,
  history: [{ date: '2026-07-31', event: 'Final rules approved.', url: 'https://www.sra.org.uk/news/news/press/safeguards-protect-client-money' }],
  admin_notes: [],
});

test('a well-formed record passes', () => {
  assert.deepEqual(validateRecord(good(), cfg, today), []);
});

test('text over the length limits is rejected', () => {
  const rec = good();
  rec.title = 'x'.repeat(cfg.limits.title + 1);
  rec.summary = 'x'.repeat(cfg.limits.summary + 1);
  rec.what_changes = Array(cfg.limits.what_changes_max_items + 1).fill('A point.');
  rec.who_it_applies_to = 'x'.repeat(cfg.limits.who_it_applies_to + 1);
  const problems = validateRecord(rec, cfg, today).join('\n');
  assert.match(problems, /title is 81 characters/);
  assert.match(problems, /summary is 241 characters/);
  assert.match(problems, /what_changes has 5 points/);
  assert.match(problems, /who_it_applies_to is 181 characters/);
});

test('one over-long point is rejected', () => {
  const rec = good();
  rec.what_changes = ['x'.repeat(cfg.limits.what_changes_item + 1)];
  assert.match(validateRecord(rec, cfg, today).join('\n'), /point 1 is 151 characters/);
});

test('unknown topic, key or stage is rejected', () => {
  const rec = { ...good(), topic: 'Conveyancing', applies_to: ['everyone'], stage: 'live' };
  const problems = validateRecord(rec, cfg, today).join('\n');
  assert.match(problems, /topic must be one of/);
  assert.match(problems, /"everyone" is not allowed/);
  assert.match(problems, /stage must be one of/);
});

test('dates must be real and in an accepted format', () => {
  for (const bad of ['31/07/2026', '2026-13-01', '2026-02-30', 'early 2027']) {
    const rec = good();
    rec.dates.decided = bad;
    assert.match(validateRecord(rec, cfg, today).join('\n'), /dates\.decided/, bad);
  }
});

test('nothing is in force before its start date', () => {
  const rec = good();
  rec.stage = 'in_force';
  rec.dates.in_force = '2027-03-01';
  assert.match(validateRecord(rec, cfg, today).join('\n'), /in the future/);
});

test('a decided change whose start date has passed must be in force', () => {
  const rec = good();
  rec.dates.in_force = '2026-11-01';
  assert.match(validateRecord(rec, cfg, today).join('\n'), /has passed/);
});

test('each stage needs its own date', () => {
  const rec = good();
  rec.stage = 'guidance';
  assert.match(validateRecord(rec, cfg, today).join('\n'), /dates\.published is required/);
});

test('an update cannot move a stage backwards or rewrite earlier dates', () => {
  const prev = good();
  const back = { ...good(), stage: 'proposed' };
  assert.match(validateUpdate(prev, back).join('\n'), /cannot move backwards/);
  const redated = good();
  redated.dates.proposed = '2025-01';
  assert.match(validateUpdate(prev, redated).join('\n'), /dates\.proposed was 2024-11/);
});

test('an archived change cannot be updated', () => {
  const prev = { ...good(), status: 'archived' };
  assert.match(validateUpdate(prev, good()).join('\n'), /archived by an admin/);
});

test('rewording alone is not a material change', () => {
  const prev = good();
  const reworded = { ...good(), title: 'Yearly accountants’ reports for firms with client money', summary: 'Different words, same facts.' };
  assert.equal(isMaterialChange(prev, reworded), false);
  const moved = good();
  moved.stage = 'in_force';
  assert.equal(isMaterialChange(prev, moved), true);
});

test('duplicates are caught by id, source page or a near-identical title', () => {
  const existing = [good()];
  assert.equal(findDuplicate({ ...good(), id: 'uk-other', source: { url: 'https://x.test/a' }, title: 'Something unrelated about sanctions' }, existing), null);
  assert.equal(findDuplicate(good(), existing).why, 'same id');
  assert.equal(findDuplicate({ ...good(), id: 'uk-other', title: 'Unrelated' }, existing).why, 'same source page');
  const near = { ...good(), id: 'uk-other', source: { url: 'https://x.test/a' }, title: 'Annual accountants’ reports for firms holding client money' };
  assert.match(findDuplicate(near, existing).why, /similar title/);
  // Archived changes still count, so the assistant cannot re-add something an admin removed.
  assert.match(findDuplicate(near, [{ ...good(), status: 'archived' }]).why, /similar title/);
});

test('different subjects score low on title similarity', () => {
  assert.ok(titleSimilarity('Warning notice on the misuse of AI', 'Annual accountants’ reports for firms holding client money') < 0.2);
});
