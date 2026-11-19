import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normaliseUrl, htmlToText, extractLinks, parseFeed, hash, listAll, newItems } from '../lib/web.mjs';

test('one page has one address', () => {
  assert.equal(normaliseUrl('https://www.sra.org.uk/news/news/press/x/?utm_source=a#top'), 'https://www.sra.org.uk/news/news/press/x');
  assert.equal(normaliseUrl('https://www.sra.org.uk/news/news/press/x'), 'https://www.sra.org.uk/news/news/press/x');
  assert.equal(normaliseUrl('https://www.gov.uk/search?q=a&page=2'), 'https://www.gov.uk/search?q=a&page=2');
});

test('page text keeps the article and drops scripts and menus', () => {
  const html = '<html><body><nav><a href="/">Home</a></nav><main><h1>New rule</h1><p>Firms must act by 1&nbsp;March&nbsp;2027 &amp; report.</p>' +
    '<ul><li>First</li><li>Second</li></ul><script>track()</script></main><footer>Cookies</footer></body></html>';
  const text = htmlToText(html);
  assert.match(text, /New rule/);
  assert.match(text, /Firms must act by 1 March 2027 & report\./);
  assert.match(text, /- First\n- Second/);
  assert.doesNotMatch(text, /Home|track|Cookies/);
});

test('links are made absolute and listed once', () => {
  const html = '<a href="/news/a/">First <b>item</b></a><a href="https://x.test/news/a">again</a><a href="#top">top</a><a href="/news/b">Second</a>';
  assert.deepEqual(extractLinks(html, 'https://x.test/news/'), [
    { url: 'https://x.test/news/a', title: 'First item' },
    { url: 'https://x.test/news/b', title: 'Second' },
  ]);
});

test('Atom and RSS feeds are both read', () => {
  const atom = '<feed><entry><title>The Money Laundering (Amendment) Regulations 2026</title>' +
    '<link rel="self" href="https://x.test/self"/><link rel="alternate" href="https://x.test/uksi/2026/621"/>' +
    '<updated>2026-06-09T10:00:00Z</updated><summary>Amends the 2017 regulations.</summary></entry></feed>';
  assert.deepEqual(parseFeed(atom), [{ url: 'https://x.test/uksi/2026/621', title: 'The Money Laundering (Amendment) Regulations 2026', date: '2026-06-09', summary: 'Amends the 2017 regulations.' }]);
  const rss = '<rss><channel><item><title><![CDATA[LSB approves rule change]]></title><link>https://y.test/news/approval/</link>' +
    '<pubDate>Fri, 31 Jul 2026 09:30:00 +0000</pubDate><description>Approved.</description></item></channel></rss>';
  assert.deepEqual(parseFeed(rss), [{ url: 'https://y.test/news/approval', title: 'LSB approves rule change', date: '2026-07-31', summary: 'Approved.' }]);
});

test('the same text always gives the same fingerprint', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});

test('a listing can be limited to the main part of the page', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tracker-'));
  const url = 'https://example.org/news';
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ [url]: 'news.txt' }));
  writeFileSync(path.join(dir, 'news.txt'), '<nav><a href="/about">About</a></nav><main><a href="/rule-change"><img></a><a href="/rule-change">Rule change</a></main><footer><a href="/privacy">Privacy</a></footer>');
  process.env.TRACKER_FIXTURES = dir;
  try {
    const source = { how: 'page', url, match: '^https://example\\.org/[^/]+$' };
    assert.equal((await listAll(source)).length, 3);
    assert.deepEqual(await listAll({ ...source, main_only: true }), [{ url: 'https://example.org/rule-change', title: 'Rule change', date: null, summary: '' }]);
  } finally {
    delete process.env.TRACKER_FIXTURES;
  }
});

test('links to PDFs are left out of what a run will read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tracker-'));
  const url = 'https://example.net/list';
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ [url]: 'list.txt' }));
  writeFileSync(path.join(dir, 'list.txt'), '<main><a href="/list/rule">Rule</a><a href="/list/slip.pdf">Correction slip</a></main>');
  process.env.TRACKER_FIXTURES = dir;
  try {
    const found = await newItems({ how: 'page', url, match: '^https://example\\.net/list/.+' }, { seen: {}, since: '2000-01-01', max: 10 });
    assert.equal(found.listed, 2);
    assert.deepEqual(found.batch.map((i) => i.url), ['https://example.net/list/rule']);
  } finally {
    delete process.env.TRACKER_FIXTURES;
  }
});

test('links are also found on a page that arrives as text', () => {
  const page = '# News\n\n- [AUSTRAC updates its guidance](/news-and-media/media-release/guidance-update) 12 November 2026\n- [**Rules** made](https://reg.example/news-and-media/media-release/rules-made "title")\n';
  assert.deepEqual(extractLinks(page, 'https://reg.example/news-and-media/'), [
    { url: 'https://reg.example/news-and-media/media-release/guidance-update', title: 'AUSTRAC updates its guidance' },
    { url: 'https://reg.example/news-and-media/media-release/rules-made', title: 'Rules made' },
  ]);
});
