import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { fetchSourceText } from '../src/network.mjs';
import { cleanText } from '../src/normalize.mjs';

// This check never changes a feed's reviewed identity or expands a host allowlist.
// A failed/moved feed remains disabled until its configuration is reviewed.
export async function checkNewsFeeds({ write = false } = {}) {
  const file = new URL('../catalog/news-feeds.json', import.meta.url);
  const registry = JSON.parse(await readFile(file, 'utf8'));
  for (let offset = 0; offset < registry.feeds.length; offset += 6) await Promise.all(registry.feeds.slice(offset, offset + 6).map(async feed => {
    feed.checkedAt = new Date().toISOString();
    try {
      const text = await fetchSourceText(feed.url, { allowedHosts: [new URL(feed.url).hostname], maxBytes: 2_000_000, timeoutMs: 15000 });
      const $ = load(text, { xmlMode: true });
      const root = $.root().children();
      const rss = root.length === 1 && root.first().is('rss') && root.attr('version') === '2.0';
      const atom = root.length === 1 && root.first().is('feed') && root.attr('xmlns') === 'http://www.w3.org/2005/Atom';
      const container = rss ? root.children('channel') : root;
      if ((!rss && !atom) || container.length !== 1 || container.children('title').length !== 1 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('invalid-feed-format');
      const plain = value => cleanText(load(value).root().text(), 300);
      if (plain(container.children('title').text()) !== plain(feed.feedTitle)) throw new Error('feed-identity-mismatch');
      feed.status = 'verified'; feed.itemCount = container.children(rss ? 'item' : 'entry').length; delete feed.reason;
      feed.sha256 = createHash('sha256').update(text).digest('hex');
    } catch (error) { feed.status = 'unavailable'; feed.reason = error.code ?? error.message; delete feed.sha256; delete feed.itemCount; }
    console.log(JSON.stringify({ id: feed.id, status: feed.status, items: feed.itemCount, reason: feed.reason }));
  }));
  registry.checkedAt = new Date().toISOString();
  if (write) await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkNewsFeeds({ write: process.argv.includes('--write') });
