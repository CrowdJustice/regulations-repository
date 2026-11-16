import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseUrl, htmlToText, extractLinks, parseFeed, hash } from '../lib/web.mjs';

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
