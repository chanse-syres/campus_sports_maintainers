import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { listConferences } from '../src/config.mjs';
import { resolveRunScope } from '../scripts/resolve-run-scope.mjs';

const script = fileURLToPath(new URL('../scripts/resolve-run-scope.mjs', import.meta.url));
test('manual maintainer scope defaults to all conferences and accepts each canonical slug', async () => {
  const all = (await listConferences()).map(conference => conference.slug);
  for (const requested of [undefined, '', 'all']) assert.deepEqual(await resolveRunScope({ eventName: 'workflow_dispatch', requested }), { conferences: all, conference: '' });
  for (const slug of all) assert.deepEqual(await resolveRunScope({ eventName: 'workflow_dispatch', requested: slug }), { conferences: [slug], conference: slug });
});
test('manual scope rejects unknown, path, shell, and output-injection selectors', async () => {
  for (const requested of ['big12', 'SEC', 'arizona', '../southeastern', 'southeastern; echo unsafe', 'southeastern\nconference=big-12', 'southeastern ', null, 12]) {
    await assert.rejects(resolveRunScope({ eventName: 'workflow_dispatch', requested }), /Unknown primary conference selector|must be a string/);
  }
});
test('scheduled scope remains national regardless of any supplied manual input', async () => {
  const expected = { conferences: (await listConferences()).map(conference => conference.slug), conference: '' };
  for (const requested of [undefined, '', 'all', 'southeastern', 'not-a-conference', 'southeastern\nconference=big-12', null]) assert.deepEqual(await resolveRunScope({ eventName: 'schedule', requested }), expected);
  for (const eventName of ['pull_request', 'pull_request_target', 'push', undefined]) await assert.rejects(resolveRunScope({ eventName, requested: 'all' }), /Unsupported maintainer event/);
});
test('scope CLI emits only validated outputs and does not echo invalid raw input', () => {
  const environment = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: '', MAINTAINER_CONFERENCE: 'southeastern' };
  const selected = spawnSync(process.execPath, [script], { env: environment, encoding: 'utf8' });
  assert.equal(selected.status, 0);
  assert.equal(selected.stdout, 'conferences=["southeastern"]\nconference=southeastern\n');
  const unsafe = 'southeastern\nconference=big-12';
  const rejected = spawnSync(process.execPath, [script], { env: { ...environment, MAINTAINER_CONFERENCE: unsafe }, encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr, 'Maintainer scope rejected: Unknown primary conference selector\n');
});
test('workflow passes manual scope through env and publishes partial bundles explicitly', async () => {
  const workflow = await readFile(new URL('../.github/workflows/maintainers.yml', import.meta.url), 'utf8');
  assert.match(workflow, /conference:\n\s+description:[^\n]+\n\s+required: true\n\s+default: all\n\s+type: string/);
  assert.match(workflow, /MAINTAINER_CONFERENCE: \$\{\{ inputs\.conference \}\}/);
  assert.match(workflow, /run: node scripts\/resolve-run-scope\.mjs >> "\$GITHUB_OUTPUT"/);
  assert.ok(!workflow.split('\n').filter(line => line.trimStart().startsWith('run:')).some(line => line.includes('inputs.conference')));
  const publication = workflow.split('\n  publish:\n')[1];
  assert.match(publication, /needs: \[prepare, collect\]/);
  assert.match(publication, /CONFERENCE: \$\{\{ needs\.prepare\.outputs\.conference \}\}/);
  assert.match(publication, /if \[ -n "\$CONFERENCE" \]; then\n\s+node scripts\/publish\.mjs --output output --conference "\$CONFERENCE"\n\s+else\n\s+node scripts\/publish\.mjs --output output/);
});
