// Temporary: can Claude's web fetch, with its built-in code step, pull the item links out of a page that arrives without them?
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const schema = { type: 'object', additionalProperties: false, required: ['items', 'note'], properties: {
  note: { type: 'string' },
  items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['url', 'title', 'date'],
    properties: { url: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' } } } } } };
const jobs = [
  ['austrac sitemap', 'https://www.austrac.gov.au/sitemap.xml', 'It is an XML sitemap. Return every <url> whose <loc> contains "/news-and-media/" or "/industry-and-business/consultations/" and whose <lastmod> is on or after 2026-09-01. Use the loc as url, the lastmod date (YYYY-MM-DD) as date, and an empty title. If the sitemap says it has further pages, say so in note.'],
  ['oaic listing', 'https://www.oaic.gov.au/news/media-centre', 'It is a news listing. Return the news items it lists: each item\'s full link address as url, its headline as title and its date as YYYY-MM-DD. Only return a url you actually found in the page\'s HTML; if the page content you can reach has no link addresses, return no items and say so in note.'],
  ['austrac listing', 'https://www.austrac.gov.au/news-and-media/news-and-media-releases', 'It is a news listing. Return the news items it lists: each item\'s full link address as url, its headline as title and its date as YYYY-MM-DD. Only return a url you actually found in the page\'s HTML; if the page content you can reach has no link addresses, return no items and say so in note.'],
];
for (const [name, url, ask] of jobs) {
  try {
    const messages = [{ role: 'user', content: `Fetch ${url} with the web_fetch tool, processing it in code so the whole page does not need to be read. ${ask}` }];
    let response;
    for (let round = 0; round < 4; round++) {
      response = await client.beta.messages.create({
        model: 'claude-opus-5-5', max_tokens: 8000, output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        tools: [{ type: 'web_fetch_20260309', name: 'web_fetch', max_uses: 3, allowed_domains: [new URL(url).hostname], use_cache: false }],
        messages,
      });
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    console.log(`\n== ${name}: stop=${response.stop_reason} blocks=${response.content.map((b) => b.type).join(',')}`);
    console.log(`usage: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!data) console.log('not JSON:', text.slice(0, 600));
    else { console.log('note:', data.note, '| items:', data.items.length); for (const i of data.items.slice(0, 12)) console.log(' ', i.date, '|', i.title.slice(0, 60), '|', i.url); }
  } catch (error) { console.log(`\n== ${name}: FAILED ${error.status ?? ''} ${String(error.message).slice(0, 400)}`); }
}
