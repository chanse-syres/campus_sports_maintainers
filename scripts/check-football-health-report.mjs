import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listSchools } from '../src/config.mjs';
import { FOOTBALL_OBSERVATION_MAX_AGE_HOURS, FOOTBALL_ARTICLE_REVIEW_AGE_DAYS } from '../src/football-health.mjs';
import { parsePublicJson, MAX_FILE_BYTES } from '../src/manifest.mjs';
import { safeUrl } from '../src/normalize.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const messages = value => Array.isArray(value) && value.length <= 10_000
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 4096);
const statuses = new Set(['ok', 'empty', 'stale', 'unavailable']);
const successful = status => status === 'ok' || status === 'empty';
const current = (value, observedAt) => timestamp(value)
  && observedAt - Date.parse(value) >= -5 * 60_000
  && observedAt - Date.parse(value) <= FOOTBALL_OBSERVATION_MAX_AGE_HOURS * 3_600_000;

/** Check a report produced by the trusted publication run, without fetching sources again. */
export async function validateFootballHealthReport(report, { now = Date.now(), getSchools = listSchools } = {}) {
  assert.ok(object(report) && report.schemaVersion === 1, 'Invalid football health report version');
  assert.ok(Number.isFinite(now) && timestamp(report.observedAt), 'Invalid football health observation time');
  const observedAt = Date.parse(report.observedAt);
  assert.equal(new Date(observedAt).toISOString(), report.observedAt, 'Noncanonical football health observation time');
  assert.ok(observedAt - now <= 5 * 60_000, 'Football health observation time is in the future');
  assert.ok(typeof report.scope === 'string' && report.scope.length > 0, 'Missing football health scope');
  const schools = (await getSchools(report.scope === 'all' ? undefined : report.scope))
    .filter(school => school.sports.some(sport => sport.slug === 'football'));
  const expected = new Map(schools.map(school => [school.slug, school]));
  for (const key of ['expectedPrograms', 'checkedPrograms', 'healthyPrograms', 'programsNeedingSourceRepair', 'programsNeedingContentReview']) {
    assert.ok(count(report[key]), `Invalid football health count: ${key}`);
  }
  assert.equal(report.expectedPrograms, expected.size, 'Football health inventory differs from configured scope');
  assert.equal(report.observationMaxAgeHours, FOOTBALL_OBSERVATION_MAX_AGE_HOURS, 'Football health observation policy differs');
  assert.equal(report.articleReviewAgeDays, FOOTBALL_ARTICLE_REVIEW_AGE_DAYS, 'Football health content review policy differs');
  assert.ok(Array.isArray(report.programs) && report.programs.length <= expected.size, 'Invalid football health programs');
  assert.ok(messages(report.errors) && typeof report.passed === 'boolean', 'Invalid football health errors or result');
  const seen = new Set();
  for (const program of report.programs) {
    assert.ok(object(program) && expected.has(program.school) && !seen.has(program.school), 'Unknown or duplicate football program');
    seen.add(program.school);
    assert.equal(program.conference, expected.get(program.school).conference.slug, 'Football program conference mismatch');
    assert.ok(statuses.has(program.status), 'Invalid football program status');
    assert.ok(count(program.articles) && program.articles <= 1_000_000
      && count(program.photos) && program.photos <= program.articles, 'Invalid football article or photo counts');
    assert.ok(timestamp(program.generatedAt) && (program.lastSuccessAt === null || timestamp(program.lastSuccessAt))
      && (program.lastArticleAt === null || timestamp(program.lastArticleAt)), 'Invalid football program timestamps');
    const age = program.lastSuccessAt === null ? null : (observedAt - Date.parse(program.lastSuccessAt)) / 3_600_000;
    assert.equal(program.observationAgeHours, age, 'Football observation age is inconsistent');
    assert.ok(messages(program.issues) && messages(program.warnings) && typeof program.passed === 'boolean', 'Invalid football program diagnostics');
    assert.equal(program.passed, program.issues.length === 0, 'Football program result contradicts its issues');
    for (const issue of program.issues) assert.ok(report.errors.includes(`${program.school}: ${issue}`), 'Football program issue is missing from report errors');
    assert.ok(Array.isArray(program.sources) && program.sources.length <= 1000, 'Invalid football source observations');
    for (const source of program.sources) {
      assert.ok(object(source) && safeUrl(source.url) && statuses.has(source.status)
        && (source.reason === null || typeof source.reason === 'string')
        && (source.lastSuccessAt === null || timestamp(source.lastSuccessAt)), 'Invalid football source observation');
      assert.equal(source.healthy, successful(source.status) && current(source.lastSuccessAt, observedAt), 'Football source health is inconsistent');
    }
    if (program.passed) assert.ok(successful(program.status) && current(program.lastSuccessAt, observedAt)
      && current(program.generatedAt, observedAt) && program.sources.length > 0
      && program.sources.every(source => source.healthy), 'Unhealthy football program cannot pass');
  }
  for (const school of expected.keys()) {
    if (!seen.has(school)) assert.ok(report.errors.some(error => error.startsWith(`${school}: `)), 'Missing football program lacks an error');
  }
  assert.equal(report.checkedPrograms, report.programs.length, 'Football checked count is inconsistent');
  assert.equal(report.healthyPrograms, report.programs.filter(program => program.passed).length, 'Football healthy count is inconsistent');
  assert.equal(report.programsNeedingSourceRepair, expected.size - report.healthyPrograms, 'Football repair count is inconsistent');
  assert.equal(report.programsNeedingContentReview, report.programs.filter(program => program.warnings.length > 0).length, 'Football content review count is inconsistent');
  assert.equal(report.passed, report.errors.length === 0, 'Football report result contradicts errors');
  if (report.passed) assert.equal(report.healthyPrograms, expected.size, 'Incomplete football coverage cannot pass');
  return report;
}

export async function run(args = process.argv.slice(2), { now = Date.now(), log = console.log } = {}) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    report: { type: 'string' }, enforce: { type: 'boolean' },
  } });
  assert.ok(values.report, '--report is required');
  const filename = path.resolve(values.report), metadata = await stat(filename);
  assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size <= MAX_FILE_BYTES, 'Invalid football health report file');
  const report = await validateFootballHealthReport(parsePublicJson(await readFile(filename)), { now });
  const summary = `${report.healthyPrograms}/${report.expectedPrograms} football programs have current successful source observations; ${report.programsNeedingSourceRepair} need source repair; ${report.programsNeedingContentReview} need content review.`;
  log(summary);
  if (!report.passed && !values.enforce) log(`::warning title=Football source health::${summary}`);
  // Prefix and flatten provider diagnostics so they cannot become workflow commands.
  for (const error of report.errors) log(` - ${error.replace(/[\r\n]+/g, ' ')}`);
  return values.enforce && !report.passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
