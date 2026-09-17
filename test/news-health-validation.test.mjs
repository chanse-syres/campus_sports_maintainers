import test from 'node:test';
import assert from 'node:assert/strict';
import { maintainSchool } from '../src/maintainer.mjs';
import { SourceError } from '../src/network.mjs';
import { validateSnapshot } from '../src/validate.mjs';
import { parsePublicJson } from '../src/manifest.mjs';

async function fixture() {
  const at = new Date().toISOString();
  const snapshot = await maintainSchool('arizona', { now: at, sources: { schools: {} }, get: async () => { throw new SourceError('http-403'); } });
  const sourceUrl = 'https://example.com/feed';
  const news = snapshot.sports.football.news = {
    status: 'ok', lastAttemptAt: at, lastSuccessAt: at, sourceUrl, season: null, reason: null,
    records: [{ id: 'example-article', title: 'Arizona football news', url: 'https://example.com/news/arizona-football', discoverySourceUrl: sourceUrl, publishedAt: at, publishedAtPrecision: 'instant', imageUrl: null, imageAlt: null, publisher: 'Example' }],
    sources: [{ status: 'ok', lastAttemptAt: at, lastSuccessAt: at, sourceUrl, reason: null, recordCount: 1 }],
  };
  return { snapshot, news, at };
}
test('news provenance cannot claim records from unavailable or empty sources', async () => {
  for (const status of ['unavailable', 'empty']) {
    const { snapshot, news } = await fixture();
    news.sources[0].status = status; news.sources[0].recordCount = 0;
    if (status === 'unavailable') news.sources[0].lastSuccessAt = null;
    await assert.rejects(validateSnapshot(snapshot), /unsuccessful or empty source/);
  }
});
test('news source counts may exceed deduplicated records but cannot undercount provenance', async () => {
  const { snapshot, news } = await fixture();
  news.sources[0].recordCount = 3;
  await validateSnapshot(snapshot);
  news.records.push({ ...news.records[0], id: 'second-article', url: 'https://example.com/news/second-arizona-football' });
  news.sources[0].recordCount = 1;
  await assert.rejects(validateSnapshot(snapshot), /exceeds source record count/);
});
test('news collection success, primary source, and status must derive from source health', async () => {
  const first = await fixture();
  first.news.status = 'stale';
  await assert.rejects(validateSnapshot(first.snapshot), /status differs from source health/);
  const second = await fixture();
  second.news.sourceUrl = 'https://example.com/other-feed';
  await assert.rejects(validateSnapshot(second.snapshot), /primary source differs/);
  const third = await fixture();
  third.news.lastSuccessAt = new Date(Date.parse(third.at) - 3600_000).toISOString();
  await assert.rejects(validateSnapshot(third.snapshot), /success time differs/);
  const fourth = await fixture();
  fourth.news.records = []; fourth.news.sources = []; fourth.news.status = 'empty';
  await assert.rejects(validateSnapshot(fourth.snapshot), /status differs from source health/);
});
test('news oldest successful observation includes successful empty feeds', async () => {
  const { snapshot, news, at } = await fixture(), previous = new Date(Date.parse(at) - 3600_000).toISOString();
  news.sources.push({ status: 'empty', lastAttemptAt: at, lastSuccessAt: previous, sourceUrl: 'https://example.com/second-feed', reason: null, recordCount: 0 });
  news.lastSuccessAt = previous;
  await validateSnapshot(snapshot);
});
test('malformed public JSON errors never echo raw input', () => {
  assert.throws(() => parsePublicJson(Buffer.from('private_unpublished_marker invalid json')), error => error.message === 'Malformed public JSON document; contents withheld');
});
