import assert from 'node:assert/strict';
import { maintainSchool } from '../src/maintainer.mjs';
import { conferenceFootballSources } from '../src/adapters/conference-football.mjs';

// Manual runner verification uses the actual maintainer, source-health handling,
// identity filters and HTTP client. It has no publication permissions.
const results = [];
for (const [slug, reviewed] of Object.entries(conferenceFootballSources)) {
  try {
    const snapshot = await maintainSchool(slug, { sport: 'football', metadataBudget: 0 });
    const news = snapshot.sports.football.news;
    assert.equal(news.status, 'ok', JSON.stringify(news.sources));
    assert.equal(news.sourceUrl, reviewed.url);
    const records = news.records.filter(record => record.discoverySourceUrl === reviewed.url);
    assert.ok(records.length > 0 && records.some(record => record.imageUrl), 'Expected school-specific stories with photos');
    const dates = records.map(record => Date.parse(record.publishedAt)).filter(Number.isFinite);
    assert.ok(dates.length && Math.max(...dates) <= Date.now() + 86_400_000, 'Invalid publication dates');
    assert.ok(Math.max(...dates) >= Date.now() - 14 * 86_400_000, 'No recent school football coverage');
    results.push({ school: slug, status: 'ok', source: reviewed.url, stories: records.length,
      photos: records.filter(record => record.imageUrl).length, latest: new Date(Math.max(...dates)).toISOString(),
      sources: news.sources.map(source => ({ url: source.sourceUrl, status: source.status })) });
  } catch (error) {
    results.push({ school: slug, status: 'failed', error: error.message });
  }
}
for (const result of results) console.log(JSON.stringify(result));
if (results.some(result => result.status !== 'ok')) process.exitCode = 1;
