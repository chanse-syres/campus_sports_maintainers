import assert from 'node:assert/strict';
import test from 'node:test';
import { footballHealth, footballHealthMarkdown } from '../src/football-health.mjs';
import { reportFootballHealth } from '../scripts/report-football-health.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const now = Date.parse('2026-09-18T04:00:00Z');
const at = '2026-09-18T03:00:00Z';
const school = () => ({ school: { slug: 'example' }, conference: { slug: 'example-conference' }, generatedAt: at,
  sports: { football: { news: { status: 'ok', lastSuccessAt: at,
    records: [{ publishedAt: '2026-09-17T12:00:00Z', imageUrl: 'https://example.org/photo.jpg' }],
    sources: [{ sourceUrl: 'https://example.org/football', status: 'ok', lastSuccessAt: at, reason: null }] } } } });
const check = snapshots => footballHealth(snapshots, { expectedSchools: ['example'], now });

test('current source observations pass and retain actual publication time', () => {
  const result = check([school()]);
  assert.equal(result.passed, true);
  assert.equal(result.healthyPrograms, 1);
  assert.equal(result.programs[0].lastArticleAt, '2026-09-17T12:00:00Z');
});

test('a freshly generated snapshot does not conceal stale source observations', () => {
  const snapshot = school();
  snapshot.sports.football.news.lastSuccessAt = '2026-09-17T12:00:00Z';
  assert.equal(check([snapshot]).passed, false);
  snapshot.sports.football.news.lastSuccessAt = at;
  snapshot.sports.football.news.sources[0].status = 'stale';
  snapshot.sports.football.news.sources[0].reason = 'http-405';
  assert.match(check([snapshot]).errors.join('\n'), /http-405/);
});

test('stale individual source fails even when another source made the program current', () => {
  const snapshot = school();
  snapshot.sports.football.news.sources.push({ sourceUrl: 'https://publisher.example/feed', status: 'ok', lastSuccessAt: '2026-09-16T00:00:00Z' });
  assert.equal(check([snapshot]).passed, false);
});

test('legitimate old publisher content warns separately from source failure', () => {
  const snapshot = school();
  snapshot.sports.football.news.records[0].publishedAt = '2026-08-03T12:00:00Z';
  const result = check([snapshot]);
  assert.equal(result.passed, true);
  assert.equal(result.programsNeedingContentReview, 1);
  assert.equal(result.programsNeedingSourceRepair, 0);
  assert.match(footballHealthMarkdown(result), /publisher content age needs review/);
});

test('verified empty feeds and unknown article dates need review without false source failures', () => {
  const snapshot = school();
  snapshot.sports.football.news.records = [];
  snapshot.sports.football.news.status = 'empty';
  const empty = check([snapshot]);
  assert.equal(empty.passed, true);
  assert.deepEqual(empty.programs[0].warnings, ['no published articles']);
  snapshot.sports.football.news.records = [{ publishedAt: null }];
  assert.deepEqual(check([snapshot]).programs[0].warnings, ['article publication dates are unknown']);
});

test('missing, duplicate and unexpected schools cannot turn a partial report green', () => {
  assert.equal(check([]).passed, false);
  assert.match(check([]).errors[0], /snapshot is missing/);
  assert.equal(check([school(), school()]).passed, false);
  const wrong = school(); wrong.school.slug = 'another-school';
  assert.equal(check([wrong]).passed, false);
  const missing = school(); delete missing.sports.football;
  assert.equal(check([missing]).passed, false);
});

test('missing, invalid and future success timestamps fail; exact age limit passes', () => {
  for (const timestamp of [null, 'invalid', '2026-09-18T05:00:00Z']) {
    const snapshot = school(); snapshot.sports.football.news.lastSuccessAt = timestamp;
    assert.equal(check([snapshot]).passed, false);
  }
  const boundary = school(); boundary.sports.football.news.lastSuccessAt = '2026-09-17T16:00:00Z';
  assert.equal(check([boundary]).passed, true);
  boundary.sports.football.news.lastSuccessAt = '2026-09-17T15:59:59Z';
  assert.equal(check([boundary]).passed, false);
});

test('stale snapshot and absent source observations are never healthy', () => {
  const snapshot = school(); snapshot.generatedAt = '2026-09-16T00:00:00Z';
  assert.equal(check([snapshot]).passed, false);
  snapshot.generatedAt = at; snapshot.sports.football.news.sources = [];
  assert.equal(check([snapshot]).passed, false);
});

test('summary escapes untrusted provider diagnostics', () => {
  const snapshot = school();
  Object.assign(snapshot.sports.football.news.sources[0], { status: 'stale', reason: '<ScRiPt> | bad\nrow' });
  const markdown = footballHealthMarkdown(check([snapshot]));
  assert.equal(markdown.includes('<'), false);
  assert.equal(markdown.includes('>'), false);
  assert.ok(markdown.includes('&lt;ScRiPt&gt; &#124; bad row'));
});

test('a missing output directory reports every expected football school instead of skipping it', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'football-health-'));
  try {
    const result = await reportFootballHealth({ output, conference: 'southeastern', now });
    assert.equal(result.passed, false);
    assert.equal(result.expectedPrograms, 16);
    assert.equal(result.checkedPrograms, 0);
    assert.equal(result.errors.length, 16);
  } finally { await rm(output, { recursive: true, force: true }); }
});
