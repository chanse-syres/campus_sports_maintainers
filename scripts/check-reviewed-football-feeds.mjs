import assert from 'node:assert/strict';
import { getSchool, getSport, loadSources } from '../src/config.mjs';
import { sourcePolicy, reviewedSportNewsUrl } from '../src/discovery.mjs';
import { fetchSourceText } from '../src/network.mjs';
import { collectOfficialNews } from '../src/adapters/official.mjs';

// Explicit manual smoke check from the same GitHub runner and HTTP client as
// maintenance. No credentials, publication, alternate routes, or browser spoofing.
const registry = await loadSources();
const results = [];
for (const slug of ['central-connecticut-state-university', 'tennessee-technological-university']) {
  try {
    const school = await getSchool(slug), policy = sourcePolicy(school);
    const source = registry.schools[slug].sports.football;
    const sport = { ...getSport(school, 'football'), routes: source.routes, aliases: source.aliases };
    const url = reviewedSportNewsUrl(source.newsUrl, sport, policy.allowedHosts);
    assert.ok(url && url === policy.sportNewsUrls.football && new URL(url).search === '?feed=rss_2.0', 'Missing reviewed primary RSS source');
    const get = value => fetchSourceText(value, { allowedHosts: policy.allowedHosts, timeoutMs: 15_000, maxBytes: 8_000_000 });
    const text = await get(url);
    assert.match(text, /^\s*(?:<\?xml[^>]*>\s*)?<rss\b/i, 'Expected the published RSS document');
    const parsed = await collectOfficialNews(text, url, { ...school, allowedHosts: policy.allowedHosts }, sport, get);
    const records = parsed.records.filter(record => record.publishedAt && Date.parse(record.publishedAt) <= Date.now() + 86_400_000);
    assert.ok(records.length > 0 && records.some(record => record.imageUrl), 'Expected dated football stories with photos');
    results.push({ school: slug, status: 'ok', source: url, stories: records.length,
      photos: records.filter(record => record.imageUrl).length, latest: records[0].publishedAt });
  } catch (error) {
    results.push({ school: slug, status: 'failed', error: error.code ?? error.message });
  }
}
for (const result of results) console.log(JSON.stringify(result));
if (results.some(result => result.status !== 'ok')) process.exitCode = 1;
