import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = await readFile(new URL('../.github/workflows/maintainers.yml', import.meta.url), 'utf8');
function job(name) {
  const block = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:\\n|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(block, `Missing ${name} workflow job`);
  return block;
}

test('publication success is separate from the enforced football health result', () => {
  const publish = job('publish');
  const health = job('football_health');
  assert.match(publish, /node scripts\/publish\.mjs --output output/);
  assert.doesNotMatch(publish, /report-football-health|football-maintenance-health/);
  assert.match(health, /^    needs: \[prepare, publish\]$/m);
  assert.match(health, /^    if: needs\.publish\.result == 'success'$/m);
  assert.doesNotMatch(health, /continue-on-error:|\|\| true|always\(\).*needs\.publish/);
});

test('post-publication health only reads the same run artifacts and reviewed conference scope', () => {
  const publish = job('publish');
  const health = job('football_health');
  assert.match(health, /^    permissions:\n      contents: read\n    steps:$/m);
  assert.doesNotMatch(health, /contents: write|GITHUB_TOKEN:|secrets\.|github-token:|repository:|run-id:/);
  assert.match(health, /persist-credentials: false/);
  assert.match(health, /run: npm ci --ignore-scripts/);
  for (const block of [publish, health]) {
    assert.match(block, /uses: actions\/download-artifact@[a-f0-9]{40}[^\n]*\n        with:\n          pattern: conference-\*\n          merge-multiple: true\n          path: output\/v1\/conferences\//);
    assert.match(block, /CONFERENCE: \$\{\{ needs\.prepare\.outputs\.conference \}\}/);
  }
  assert.doesNotMatch(health, /src\/cli\.mjs|scripts\/download-previous\.mjs|scripts\/publish\.mjs|scripts\/resolve-data-ref\.mjs/);
  assert.match(health, /if \[ -n "\$CONFERENCE" \]; then\n\s+node scripts\/report-football-health\.mjs --output output --conference "\$CONFERENCE" --write-report --markdown --enforce >> "\$GITHUB_STEP_SUMMARY"\n\s+else\n\s+node scripts\/report-football-health\.mjs --output output --write-report --markdown --enforce >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(health, /if: always\(\) && steps\.football_health\.outcome != 'skipped'/);
  assert.match(health, /name: football-maintenance-health\n          path: output\/football-health\.json/);
});

test('enforced unhealthy football report fails while preserving the downloadable evidence', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'published-football-health-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/report-football-health.mjs', '--output', output, '--conference', 'northeast', '--write-report', '--markdown', '--enforce'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(path.join(output, 'football-health.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.scope, 'northeast');
    assert.ok(report.expectedPrograms > 0);
    assert.equal(report.checkedPrograms, 0);
    assert.ok(report.errors.length > 0);
    assert.match(result.stdout, /Football maintenance health/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
