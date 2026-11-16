// Rules the code enforces on every record, whatever the AI wrote.
// Nothing reaches data/ unless it passes these.

export const STAGES = ['proposed', 'decided', 'in_force', 'guidance'];
const STAGE_ORDER = { proposed: 0, decided: 1, in_force: 2 };
// The date that marks when a record reached its stage.
export const STAGE_DATE = { proposed: 'proposed', decided: 'decided', in_force: 'in_force', guidance: 'published' };
const DATE_KEYS = ['proposed', 'decided', 'in_force', 'published'];
const PARTIAL_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const ID = /^[a-z]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

// First day of the period a date names: "2027" → 2027-01-01, "2027-03" → 2027-03-01.
export function periodStart(date) {
  return date.length === 4 ? `${date}-01-01` : date.length === 7 ? `${date}-01` : date;
}

// Last day of the period a date names: "2027" → 2027-12-31, "2027-02" → 2027-02-28.
export function periodEnd(date) {
  if (date.length === 10) return date;
  const [year, month] = date.length === 4 ? [Number(date), 12] : date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function isRealDate(date) {
  const d = new Date(`${periodStart(date)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === periodStart(date);
}

export function validateRecord(rec, cfg, today) {
  const problems = [];
  const lim = cfg.limits;
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const tooLong = (name, value, max) => {
    if (text(value) && value.length > max) problems.push(`${name} is ${value.length} characters; the limit is ${max}`);
  };

  if (!ID.test(rec.id ?? '') || rec.id.length > 60) problems.push('id must be lowercase words joined by hyphens, 60 characters at most');
  else if (!rec.id.startsWith(`${rec.country}-`)) problems.push(`id must start with "${rec.country}-"`);

  for (const field of ['regulator', 'title', 'summary', 'who_it_applies_to']) {
    if (!text(rec[field])) problems.push(`${field} is missing`);
  }
  tooLong('title', rec.title, lim.title);
  tooLong('summary', rec.summary, lim.summary);
  tooLong('who_it_applies_to', rec.who_it_applies_to, lim.who_it_applies_to);
  tooLong('regulator', rec.regulator, 40);

  if (!Array.isArray(rec.what_changes) || rec.what_changes.length === 0) problems.push('what_changes needs at least one point');
  else {
    if (rec.what_changes.length > lim.what_changes_max_items) {
      problems.push(`what_changes has ${rec.what_changes.length} points; the limit is ${lim.what_changes_max_items}`);
    }
    rec.what_changes.forEach((point, i) => {
      if (!text(point)) problems.push(`what_changes point ${i + 1} is empty`);
      tooLong(`what_changes point ${i + 1}`, point, lim.what_changes_item);
    });
  }

  const keys = Object.keys(cfg.applies_to[rec.country] ?? {});
  if (!Array.isArray(rec.applies_to) || rec.applies_to.length === 0) problems.push('applies_to needs at least one key');
  else {
    for (const key of rec.applies_to) if (!keys.includes(key)) problems.push(`applies_to key "${key}" is not allowed; use one of: ${keys.join(', ')}`);
    if (rec.applies_to.includes('all') && rec.applies_to.length > 1) problems.push('applies_to "all" cannot be combined with other keys');
  }

  if (!cfg.topics.includes(rec.topic)) problems.push(`topic must be one of: ${cfg.topics.join(', ')}`);
  if (!STAGES.includes(rec.stage)) problems.push(`stage must be one of: ${STAGES.join(', ')}`);

  const dates = rec.dates ?? {};
  for (const key of DATE_KEYS) {
    const value = dates[key];
    if (value == null) continue;
    if (!PARTIAL_DATE.test(value) || !isRealDate(value)) problems.push(`dates.${key} "${value}" must be YYYY, YYYY-MM or YYYY-MM-DD`);
  }
  tooLong('dates.in_force_text', dates.in_force_text, lim.in_force_text);
  if (problems.length) return problems;

  if (STAGES.includes(rec.stage) && !dates[STAGE_DATE[rec.stage]]) {
    problems.push(`stage is "${rec.stage}", so dates.${STAGE_DATE[rec.stage]} is required`);
  }
  if (rec.stage === 'in_force' && dates.in_force && periodStart(dates.in_force) > today) {
    problems.push(`stage is "in_force" but dates.in_force (${dates.in_force}) is in the future; use "decided"`);
  }
  if (rec.stage === 'decided' && dates.in_force && (dates.in_force.length === 10 ? dates.in_force <= today : periodEnd(dates.in_force) < today)) {
    problems.push(`dates.in_force (${dates.in_force}) has passed; the stage should be "in_force"`);
  }
  if (['in_force', 'guidance'].includes(rec.stage) && dates.in_force_text) {
    problems.push('dates.in_force_text is only for a start date that is still to come; leave it empty here');
  }
  if (rec.stage === 'proposed' && dates.decided) {
    problems.push('a proposed change cannot have a decided date');
  }
  for (const key of ['proposed', 'decided', 'published']) {
    if (dates[key] && periodStart(dates[key]) > today) problems.push(`dates.${key} (${dates[key]}) is in the future`);
  }
  return problems;
}

// Extra rules when the AI updates an existing record.
export function validateUpdate(prev, next) {
  const problems = [];
  if (prev.status === 'archived') problems.push('this change was archived by an admin and must not be updated');
  if ((prev.stage === 'guidance') !== (next.stage === 'guidance')) problems.push('guidance cannot turn into a rule change, or the reverse; that is a different change');
  else if (STAGE_ORDER[next.stage] < STAGE_ORDER[prev.stage]) problems.push(`stage cannot move backwards from "${prev.stage}" to "${next.stage}"`);
  for (const key of ['proposed', 'decided']) {
    const before = prev.dates?.[key];
    if (before && next.dates?.[key] !== before && STAGE_ORDER[prev.stage] > STAGE_ORDER[key]) {
      problems.push(`dates.${key} was ${before} and must not change`);
    }
  }
  return problems;
}

// An update must change a fact. Rewording alone is not an update.
export function isMaterialChange(prev, next) {
  const facts = (r) => JSON.stringify([r.stage, r.dates, [...r.applies_to].sort(), r.what_changes]);
  return facts(prev) !== facts(next);
}

const STOP = new Set(('a an and are as at be by for from has have in into is it its must new now of on or that the their ' +
  'to will with firms firm law rules rule change changes').split(' '));

export function titleWords(title) {
  return new Set(title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .map((w) => w.replace(/(ies|es|s|ing|ed)$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w)));
}

export function titleSimilarity(a, b) {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

// Does a brand new record look like one we already hold (live or archived)?
export function findDuplicate(rec, existing, threshold = 0.6) {
  for (const other of existing) {
    if (other.id === rec.id) return { id: other.id, why: 'same id' };
    const urls = [other.source?.url, ...(other.history ?? []).map((h) => h.url)].filter(Boolean);
    if (urls.includes(rec.source?.url)) return { id: other.id, why: 'same source page' };
    if (other.regulator === rec.regulator && titleSimilarity(other.title, rec.title) >= threshold) {
      return { id: other.id, why: 'very similar title from the same regulator' };
    }
  }
  return null;
}
