// Reading sources: listings (page, feed, GOV.UK search) and the text of one page.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const USER_AGENT = 'LeglRegulationTracker/1.0 (+https://www.legl.com)';
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

export async function fetchRaw(url) {
  const fixture = await fixtureFor(url);
  if (fixture != null) return fixture;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/application\/pdf/i.test(res.headers.get('content-type') ?? '')) throw new Error('PDF pages are not supported yet');
      return await res.text();
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
    if (!links.has(url)) links.set(url, stripTags(m[2]));
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

async function govukSearch(source) {
  const params = new URLSearchParams({ filter_organisations: source.organisation, order: '-public_timestamp', count: '40', fields: 'title,link,public_timestamp,description' });
  if (source.query) params.set('q', source.query);
  const data = JSON.parse(await fetchRaw(`https://www.gov.uk/api/search.json?${params}`));
  return (data.results ?? []).map((r) => ({
    url: normaliseUrl(new URL(r.link, 'https://www.gov.uk').toString()),
    title: r.title ?? '',
    date: r.public_timestamp ? toDate(r.public_timestamp) : null,
    summary: r.description ?? '',
  }));
}

// The items a source currently lists, newest first: [{ url, title, date, summary }].
export async function listCandidates(source) {
  let items;
  if (source.how === 'govuk') items = await govukSearch(source);
  else if (source.how === 'feed') items = parseFeed(await fetchRaw(source.url));
  else if (source.how === 'page') {
    const match = new RegExp(source.match);
    const listing = normaliseUrl(source.url);
    items = extractLinks(await fetchRaw(source.url), source.url)
      .filter((l) => match.test(l.url) && l.url !== listing)
      .map((l) => ({ ...l, date: null, summary: '' }));
  } else throw new Error(`unknown source type "${source.how}"`);

  if (source.keywords?.length) {
    const words = source.keywords.map((k) => k.toLowerCase());
    items = items.filter((i) => words.some((k) => `${i.title} ${i.summary}`.toLowerCase().includes(k)));
  }
  return items;
}
