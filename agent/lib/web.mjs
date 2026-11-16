// Reading sources: listings (page, feed, GOV.UK search) and the text of one page.

import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const USER_AGENT = 'Mozilla/5.0 (compatible; LeglRegulationTracker/1.0; +https://www.legl.com)';
const MAX_PAGE_CHARS = 24000;

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// One address per page: no fragment, no tracking parameters, no trailing slash.
export function normaliseUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  let out = url.toString();
  if (!url.search && url.pathname.length > 1) out = out.replace(/\/$/, '');
  return out;
}

// Tests read pages from a folder instead of the web: TRACKER_FIXTURES/index.json maps URL → file.
let fixtures;
async function fixtureFor(url) {
  const dir = process.env.TRACKER_FIXTURES;
  if (!dir) return null;
  fixtures ??= JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  const file = fixtures[url];
  if (!file) throw new Error('HTTP 404 (no fixture)');
  return readFile(path.join(dir, file), 'utf8');
}

// Set TRACKER_RECORD to a folder to keep a copy of every page read, in the layout TRACKER_FIXTURES expects.
const recorded = {};
function record(url, body) {
  const dir = process.env.TRACKER_RECORD;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  recorded[url] = `${hash(url)}.txt`;
  writeFileSync(path.join(dir, recorded[url]), body);
  writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(recorded, null, 1)}\n`);
}

export async function fetchRaw(url) {
  const fixture = await fixtureFor(url);
  if (fixture != null) return fixture;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'en-GB,en;q=0.9' },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/application\/pdf/i.test(res.headers.get('content-type') ?? '')) throw new Error('PDF pages are not supported yet');
      const body = await res.text();
      record(url, body);
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function htmlToText(html) {
  let s = html;
  const main = s.match(/<main\b[\s\S]*<\/main>/i) ?? s.match(/<article\b[\s\S]*<\/article>/i);
  if (main) s = main[0];
  else s = s.replace(/<(header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s
    .replace(/<(script|style|noscript|svg|nav|form|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/ul|\/ol|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

export async function fetchPageText(url) {
  const raw = await fetchRaw(url);
  const text = /<[a-z!][\s\S]*>/i.test(raw) ? htmlToText(raw) : raw.trim().slice(0, MAX_PAGE_CHARS);
  if (text.length < 200) throw new Error('page has almost no text (blocked or empty)');
  return text;
}

export function extractLinks(html, baseUrl) {
  const links = new Map();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = normaliseUrl(new URL(decodeEntities(m[1]), baseUrl).toString()); } catch { continue; }
    // Keep the first link text that is not empty (an image link often comes before the headline link).
    if (!links.get(url)) links.set(url, stripTags(m[2]));
  }
  return [...links].map(([url, title]) => ({ url, title }));
}

const toDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function parseFeed(xml) {
  const tag = (block, names) => {
    for (const name of names) {
      const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      if (m) return stripTags(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    }
    return null;
  };
  const items = [];
  for (const m of xml.matchAll(/<(entry|item)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const atomLink = [...block.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0])
      .find((l) => /href=/.test(l) && (!/rel=/.test(l) || /rel=["']alternate["']/.test(l)));
    const url = atomLink ? decodeEntities(atomLink.match(/href=["']([^"']+)["']/)[1]) : tag(block, ['link', 'guid']);
    const date = tag(block, ['published', 'updated', 'pubDate', 'dc:date']);
    if (!url) continue;
    items.push({ url: normaliseUrl(url), title: tag(block, ['title']) ?? '', date: date ? toDate(date) : null, summary: tag(block, ['summary', 'description']) ?? '' });
  }
  return items;
}

// A look further back walks older listing pages too. These cap how far it will walk.
const MAX_DATED_PAGES = 400; // a listing with dates stops by itself once it passes the look-back date
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const reachedBack = (items, since) => Boolean(since) && items.length > 0 && items.every((i) => i.date) && items.some((i) => i.date < since);

async function govukSearch(source, { pages, since }) {
  const size = pages > 1 ? 100 : 40;
  const items = [];
  for (let start = 0; start < size * (pages > 1 ? 20 : 1); start += size) {
    const params = new URLSearchParams({ filter_organisations: source.organisation, order: '-public_timestamp', count: String(size), fields: 'title,link,public_timestamp,description' });
    if (source.query) params.set('q', source.query);
    if (start) params.set('start', String(start));
    const data = JSON.parse(await fetchRaw(`https://www.gov.uk/api/search.json?${params}`));
    const found = (data.results ?? []).map((r) => ({
      url: normaliseUrl(new URL(r.link, 'https://www.gov.uk').toString()),
      title: r.title ?? '',
      date: r.public_timestamp ? toDate(r.public_timestamp) : null,
      summary: r.description ?? '',
    }));
    items.push(...found);
    if (found.length < size || reachedBack(found, since)) break;
    await pause(300);
  }
  return items;
}

// The address of the next, older page of a listing. A source can name it as "more": either a pattern with {n} for the page
// number, or the address of an archive that carries on where the listing stops. Otherwise the page's rel="next" link is followed.
function nextPage(source, body, current, n) {
  if (source.more?.includes('{n}')) return source.more.replace('{n}', String(n + 1));
  if (source.more && n === 1) return source.more;
  const tag = body.match(/<(?:a|link)\b[^>]*\brel=["']next["'][^>]*>/i)?.[0];
  const href = tag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!href) return null;
  try { return new URL(decodeEntities(href), current).toString(); } catch { return null; }
}

// The items from a source that a run should read now: in the look-back window, not seen before, oldest first.
export async function newItems(source, { seen, since, max, pages = 1 }) {
  const all = await listAll(source, { pages, since });
  const words = (source.keywords ?? []).map((k) => k.toLowerCase());
  const items = words.length ? all.filter((i) => words.some((k) => `${i.title} ${i.summary}`.toLowerCase().includes(k))) : all;
  const inWindow = items.filter((i) => !i.date || i.date >= since);
  // New means: never read, or not read successfully yet, or listed with a later date than when it was last read (the page was updated).
  const fresh = inWindow.filter((i) => {
    const before = seen[normaliseUrl(i.url)];
    return !before || before.decision === 'failed' || Boolean(i.date && i.date > (before.listed ?? before.date));
  });
  // Oldest first, so a proposal is recorded before the decision on it.
  const batch = fresh.slice(0, max).reverse();
  if (batch.every((i) => i.date)) batch.sort((a, b) => a.date.localeCompare(b.date));
  return { listed: all.length, matched: items.length, inWindow: inWindow.length, fresh: fresh.length, batch };
}

// Everything a source currently lists, newest first: [{ url, title, date, summary }].
// "pages" above 1 also reads older listing pages: up to that many when the listing shows no dates,
// and as many as it takes to pass "since" when it does.
export async function listAll(source, { pages = 1, since = null } = {}) {
  if (source.how === 'govuk') return govukSearch(source, { pages, since });
  if (!['feed', 'page'].includes(source.how)) throw new Error(`unknown source type "${source.how}"`);
  const match = source.how === 'page' ? new RegExp(source.match) : null;
  // The listing itself, whatever its query string: page 2 of a listing is not an item.
  const bare = (address) => { const u = new URL(address); return `${u.origin}${u.pathname.replace(/\/$/, '')}`; };
  const listing = bare(source.url);
  const items = new Map();
  const visited = new Set();
  let url = source.url;
  for (let n = 1; url && !visited.has(url); n++) {
    visited.add(url);
    const body = await fetchRaw(url);
    let found;
    if (source.how === 'feed') found = parseFeed(body);
    else {
      // "main_only" ignores menus and footers, for sites whose item links look like every other link.
      const html = source.main_only ? body.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? body : body;
      found = extractLinks(html, url).filter((l) => match.test(l.url) && bare(l.url) !== listing).map((l) => ({ ...l, date: null, summary: '' }));
    }
    const fresh = found.filter((item) => !items.has(item.url));
    for (const item of fresh) items.set(item.url, item);
    const dated = found.length > 0 && found.every((i) => i.date);
    if (pages <= 1 || !fresh.length || reachedBack(found, since) || n >= (dated ? MAX_DATED_PAGES : pages)) break;
    url = nextPage(source, body, url, n);
    if (url) await pause(300);
  }
  return [...items.values()];
}
