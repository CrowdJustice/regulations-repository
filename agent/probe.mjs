// Temporary: when was each page actually retrieved? Tells a live read from a stored copy.
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const urls = [
  'https://www.austrac.gov.au/news-and-media/news-and-media-releases',
  'https://www.austrac.gov.au/news-and-media',
  'https://www.austrac.gov.au/news-and-media/news-and-media-releases?page=0',
  'https://www.austrac.gov.au/industry-and-business/consultations',
  'https://www.oaic.gov.au/news/media-centre',
  'https://www.oaic.gov.au/engage-with-us/consultations',
];
for (const url of urls) {
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5', max_tokens: 512, output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      tools: [{ type: 'web_fetch_20260309', name: 'web_fetch', max_uses: 1, allowed_domains: [new URL(url).hostname], max_content_tokens: 4000, use_cache: false }],
      messages: [{ role: 'user', content: `Call the web_fetch tool once, directly, on ${url} and then reply with the single word "done".` }],
    });
    const r = response.content.find((b) => b.type === 'web_fetch_tool_result');
    if (r?.content.type === 'web_fetch_result') console.log(`${url}\n  retrieved_at=${r.content.retrieved_at} chars=${r.content.content.source.data?.length}\n  ${String(r.content.content.source.data).replace(/\s+/g, ' ').slice(0, 260)}`);
    else console.log(`${url}\n  ${r ? 'error=' + r.content.error_code : 'no fetch; stop=' + response.stop_reason}`);
  } catch (error) { console.log(`${url}\n  FAILED ${error.status ?? ''} ${String(error.message).slice(0, 300)}`); }
}
