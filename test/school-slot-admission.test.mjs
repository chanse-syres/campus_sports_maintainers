import assert from 'node:assert/strict';
import test from 'node:test';
import * as admission from '../scripts/school-slot-admission.mjs';

const texas = '2026-11-16T02:19Z';
const oregon = '2026-11-15T23:37Z';
const native = (id, cron, created, extra = {}) => ({
  id, event: 'schedule', display_title: `School schedule ${cron}`, head_branch: 'main',
  created_at: created, run_attempt: 1, ...extra,
});
const catchup = (id, lane, slot, created, extra = {}) => ({
  id, event: 'workflow_dispatch', display_title: `School catch-up ${lane} ${slot}`,
  head_branch: 'main', created_at: created, run_attempt: 1, ...extra,
});
const earlyTexas = catchup(1, 'texas-news', texas, '2026-11-16T02:56:53Z');
const lateTexas = native(2, '19 2,14 * * *', '2026-11-16T09:44:15Z');
const earlyOregon = catchup(3, 'osu-news', oregon, '2026-11-16T00:16:53Z');
const lateOregon = native(4, '37 11,17,23 * * *', '2026-11-16T02:58:16Z');
const nextTexas = native(5, '19 2,14 * * *', '2026-11-16T14:19:10Z');
const nextOregon = native(6, '37 11,17,23 * * *', '2026-11-16T11:37:10Z');
const completed = (name, publish = false) => ({
  name, status: 'completed', conclusion: publish ? 'failure' : 'success',
  steps: [{ name: 'Publish validated commits to the private app', conclusion: 'success' },
    ...(publish ? [{ name: 'Confirm public data push', conclusion: 'success' }] : [])],
});

function plan(run, prior, receipts, { lane, attempt = 1, manual = false, slot } = {}) {
  assert.equal(typeof admission.planSchoolPublication, 'function', 'slot admission must be implemented');
  const input = { lane: lane ?? (run === lateOregon || run === nextOregon ? 'osu-news' : 'texas-news'),
    attempt, id: run.id, event: run.event,
    scheduledSlot: manual ? '' : slot ?? (run.event === 'workflow_dispatch' ? run.display_title.split(' ').at(-1) : '') };
  return admission.planSchoolPublication(input, {
    getRun: async () => run,
    listRuns: async () => prior,
    listJobs: async (id, attemptNumber) => receipts[`${id}:${attemptNumber}`] ?? [],
  });
}

test('a successful catch-up covers the matching late native run on both school schedules', async () => {
  assert.deepEqual(await plan(lateTexas, [earlyTexas], {'1:1': [completed('maintain')]}),
    { eligible: false, slot: texas, coveredBy: 1 });
  assert.deepEqual(await plan(lateOregon, [earlyOregon], {'3:1': [completed('maintain')]}),
    { eligible: false, slot: oregon, coveredBy: 3 });
});

test('the reverse order also skips a catch-up after the native job confirmed the slot', async () => {
  const scheduled = native(7, '19 2,14 * * *', '2026-11-16T02:20:00Z');
  assert.deepEqual(await plan(earlyTexas, [scheduled],
    {'7:1': [completed('maintain')]}),
    { eligible: false, slot: texas, coveredBy: 7 });
});

test('the next Texas and Oregon State slots can collect and publish late stories', async () => {
  const runs = [lateTexas, earlyTexas, lateOregon, earlyOregon];
  const receipts = {'1:1': [completed('maintain')], '3:1': [completed('maintain')]};
  assert.deepEqual(await plan(nextTexas, runs, receipts), { eligible: true, slot: '2026-11-16T14:19Z' });
  assert.deepEqual(await plan(nextOregon, runs, receipts), { eligible: true, slot: '2026-11-16T11:37Z' });
});

test('a failed or skipped publisher does not reserve a slot', async () => {
  const name = 'maintain';
  for (const conclusion of ['failure', 'skipped', 'cancelled']) {
    assert.deepEqual(await plan(lateTexas, [earlyTexas], {'1:1': [{ name, status: 'completed',
      conclusion, steps: [{ name: 'Publish validated commits to the private app', conclusion: 'skipped' }] }]}),
    { eligible: true, slot: texas });
  }
});

test('retrying a run cannot repeat an already confirmed push, even if a later report failed', async () => {
  assert.deepEqual(await plan(lateTexas, [lateTexas],
    {'2:1': [completed('maintain', true)]}, { attempt: 2 }),
    { eligible: false, slot: texas, coveredBy: 2 });
});

test('a successful diagnostics-only push inside a failed publisher does not block recovery', async () => {
  const receipt = { name: 'maintain', status: 'completed', conclusion: 'failure',
    steps: [{ name: 'Publish validated commits to the private app', conclusion: 'success' },
      { name: 'Confirm public data push', conclusion: 'skipped' }] };
  assert.deepEqual(await plan(lateTexas, [earlyTexas], {'1:1': [receipt]}), { eligible: true, slot: texas });
});

test('an on-demand refresh bypasses slot history; invalid or early catch-up slots fail visibly', async () => {
  assert.deepEqual(await admission.planSchoolPublication(
    { event: 'workflow_dispatch', lane: 'osu-news', scheduledSlot: '' }, {}),
  { eligible: true, slot: '' });
  const impossible = catchup(1, 'texas-news', texas, '2026-11-16T02:15:00Z');
  await assert.rejects(plan(impossible, [], {}), /scheduled slot/i);
  await assert.rejects(plan(earlyTexas, [], {}, {slot: '2026-11-16T03:19Z'}), /scheduled slot/i);
});

test('an unavailable receipt inventory cannot be mistaken for confirmed coverage or an empty history', async () => {
  await assert.rejects(admission.planSchoolPublication(
    { event: 'schedule', lane: 'texas-news', id: 2, attempt: 1 },
    { getRun: async () => lateTexas, listRuns: async () => null }),
  /history/i);
});
