import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/school-maintenance.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const schedule = workflow.match(/^  schedule:\n((?:    - cron: '[^']+'\n)+)/m)[1];
const cronExpressions = [...schedule.matchAll(/cron: '([^']+)'/g)].map(match => match[1]);
const selector = workflow.match(/- name: Select the school job\n[\s\S]*?\n        run: \|\n((?:          [^\n]*\n)+)/)[1].replace(/^ {10}/gm, '');
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';

function route(event, cron = '', lane = '', slot = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'school-schedule-test-'));
  const output = path.join(dir, 'github-output').replaceAll('\\', '/');
  writeFileSync(output, '');
  try {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      input: selector, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GITHUB_EVENT_NAME: event, SCHEDULE: cron, REQUESTED_LANE: lane, REQUESTED_SLOT: slot, GITHUB_OUTPUT: output },
    });
    assert.ifError(result.error);
    return { code: result.status, output: readFileSync(output, 'utf8').trim() };
  } finally {
    unlinkSync(output);
    rmdirSync(dir);
  }
}

test('native cron runs Texas news twice daily and keeps all other lanes on their existing schedules', () => {
  const expected = [
    ['19 2,14 * * *', 'texas-news'], ['37 11,17,23 * * *', 'osu-news'],
    ['7 12 * * *', 'osu-sports'], ['43 12 * * *', 'texas-sports'],
  ];
  assert.deepEqual(cronExpressions, expected.map(([cron]) => cron));
  for (const [cron, lane] of expected) {
    assert.deepEqual(route('schedule', cron), { code: 0, output: `name=${lane}` });
  }
});

test('Texas news accepts its two catch-up slots and explicit manual refreshes, but rejects old hourly slots', () => {
  for (const slot of ['', '2026-11-16T02:19Z', '2026-11-16T14:19Z']) {
    assert.deepEqual(route('workflow_dispatch', '', 'texas-news', slot), { code: 0, output: 'name=texas-news' });
  }
  for (const slot of ['2026-11-16T03:19Z', '2026-11-16T02:20Z', '2026-11-31T02:19Z']) {
    assert.deepEqual(route('workflow_dispatch', '', 'texas-news', slot), { code: 1, output: '' });
  }
});
