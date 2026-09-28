import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSchools } from '../src/config.mjs';
import { footballHealth } from '../src/football-health.mjs';
import { run, validateFootballHealthReport } from '../scripts/check-football-health-report.mjs';

const now = Date.parse('2026-09-27T16:00:00.000Z');
const at = '2026-09-27T15:00:00.000Z';
async function fixture(scope = 'all', denied = []) {
  const schools = (await listSchools(scope === 'all' ? undefined : scope)).filter(school => school.sports.some(sport => sport.slug === 'football'));
  const snapshots = schools.map(school => ({ school: { slug: school.slug }, conference: school.conference, generatedAt: at,
    sports: { football: { news: { status: denied.includes(school.slug) ? 'stale' : 'ok', lastSuccessAt: at,
      records: denied.includes(school.slug) ? [] : [{ publishedAt: at, imageUrl: 'https://example.edu/team.jpg' }],
      sources: [{ sourceUrl: 'https://example.edu/football', status: denied.includes(school.slug) ? 'stale' : 'ok',
        lastSuccessAt: at, reason: denied.includes(school.slug) ? 'http-405' : null }] } } } }));
  return { ...footballHealth(snapshots, { expectedSchools: schools.map(school => school.slug), now }), scope };
}

async function withReport(report, task) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'football-report-'));
  try {
    const filename = path.join(directory, 'report.json');
    await writeFile(filename, typeof report === 'string' ? report : JSON.stringify(report));
    return await task(filename);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('264/266 report keeps both blocked schools visible and fails only enforced source health', async () => {
  const report = await fixture('all', ['central-connecticut-state-university', 'tennessee-technological-university']);
  assert.equal(report.expectedPrograms, 266);
  assert.equal(report.healthyPrograms, 264);
  assert.equal(report.programsNeedingContentReview, 2);
  await withReport(report, async filename => {
    const messages = [];
    assert.equal(await run(['--report', filename], { now, log: message => messages.push(message) }), 0);
    assert.ok(messages.some(message => message.startsWith('::warning title=Football source health::264/266')));
    assert.ok(messages.some(message => message.includes('tennessee-technological-university: source') && message.includes('http-405')));
    assert.ok(messages.some(message => message.includes('central-connecticut-state-university: source') && message.includes('http-405')));
    assert.equal(await run(['--report', filename, '--enforce'], { now, log: () => {} }), 1);
  });
});

test('healthy national and conference reports pass enforcement without warnings', async () => {
  for (const scope of ['all', 'southeastern']) {
    await withReport(await fixture(scope), async filename => {
      const messages = [];
      assert.equal(await run(['--report', filename, '--enforce'], { now, log: message => messages.push(message) }), 0);
      assert.equal(messages.length, 1);
    });
  }
});

test('a configured conference without football has a valid zero-program report', async () => {
  // Current primary conferences all sponsor football somewhere; a future valid
  // conference with only other sports must not fail an empty football check.
  const scope = 'basketball-conference';
  const report = { ...footballHealth([], { expectedSchools: [], now }), scope };
  assert.equal(report.expectedPrograms, 0);
  assert.equal((await validateFootballHealthReport(report, { now, getSchools: async requested => {
    assert.equal(requested, scope);
    return [{ slug: 'basketball-school', conference: { slug: scope }, sports: [{ slug: 'basketball' }] }];
  } })).passed, true);
});

test('missing, malformed, empty and unknown-scope reports always fail', async () => {
  await assert.rejects(run([], { now }), /--report is required/);
  await withReport('{}', async filename => {
    await assert.rejects(run(['--report', `${filename}.missing`], { now }), /ENOENT/);
  });
  for (const content of ['{', '', '{}', '[]']) {
    await withReport(content, async filename => {
      for (const flags of [[], ['--enforce']]) await assert.rejects(run(['--report', filename, ...flags], { now }));
    });
  }
  const report = await fixture('southeastern'); report.scope = 'not-a-conference';
  await assert.rejects(validateFootballHealthReport(report, { now }), /Unknown primary conference/);
});

test('report times beyond clock tolerance, malformed and noncanonical times are rejected', async () => {
  for (const observedAt of ['2026-09-27T16:05:00.001Z', 'not-a-date', '2026-09-27']) {
    const report = await fixture('southeastern'); report.observedAt = observedAt;
    await assert.rejects(validateFootballHealthReport(report, { now }), /observation time/);
  }
  const report = await fixture('southeastern');
  assert.equal((await validateFootballHealthReport(report, { now: now - 5 * 60_000 })).passed, true);
});

test('aggregate counts, required fields and contradictory pass flags cannot become green', async () => {
  for (const mutate of [
    report => { report.expectedPrograms--; },
    report => { report.checkedPrograms++; },
    report => { report.healthyPrograms--; },
    report => { report.programsNeedingSourceRepair++; },
    report => { report.programsNeedingContentReview++; },
    report => { report.passed = false; },
    report => { delete report.errors; },
    report => { report.errors = ['unresolved issue']; },
    report => { report.programs[0].photos = report.programs[0].articles + 1; },
    report => { report.programs[0].articles = -1; },
    report => { report.programs[0].sources[0].healthy = false; },
    report => { report.programs[0].sources[0].status = 'stale'; },
    report => { report.programs[0].observationAgeHours++; },
    report => { report.programs[0].conference = 'wrong'; },
    report => { report.programs[1] = report.programs[0]; },
  ]) {
    const report = await fixture('southeastern'); mutate(report);
    await assert.rejects(validateFootballHealthReport(report, { now }));
  }
});

test('missing rows and source issues require explicit report errors', async () => {
  const denied = await fixture('all', ['tennessee-technological-university']);
  denied.errors = [];
  await assert.rejects(validateFootballHealthReport(denied, { now }), /missing from report errors/);
  const missing = await fixture('southeastern'), removed = missing.programs.pop();
  missing.checkedPrograms--; missing.healthyPrograms--; missing.programsNeedingSourceRepair++;
  missing.passed = false;
  await assert.rejects(validateFootballHealthReport(missing, { now }), /Missing football program lacks an error/);
  missing.errors = [`${removed.school}: football snapshot is missing`];
  assert.equal((await validateFootballHealthReport(missing, { now })).passed, false);
});

test('content-age warnings remain valid without becoming a failed source-health report', async () => {
  const report = await fixture('southeastern');
  report.programs[0].warnings.push('publisher content age needs review; successful collection does not establish new content');
  report.programsNeedingContentReview = 1;
  assert.equal((await validateFootballHealthReport(report, { now })).passed, true);
});
