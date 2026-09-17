import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPOSITORY, listSchools } from '../src/config.mjs';
import { parsePublicJson, limitedResponse, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, validateManifest } from '../src/manifest.mjs';
import { checkedDirectory, commitSha, githubRequest, validateFiles } from './publish.mjs';

export function assertCollectionContext(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Bootstrap requires GitHub Actions');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected bootstrap repository');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Bootstrap is restricted to main');
  assert.ok(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unexpected bootstrap event');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/maintainers.yml@refs/heads/main`, 'Unexpected bootstrap workflow');
}
export async function downloadPrevious(conference, directory = 'previous', { request, fetchFile, validator, commit, rebootstrap = false, env = process.env } = {}) {
  await listSchools(conference);
  assert.ok(typeof conference === 'string', 'Conference is required');
  if (rebootstrap) {
    assertCollectionContext(env);
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Rebootstrap requires an explicit manual run');
    assert.equal(env.MAINTAINER_REBOOTSTRAP, 'true', 'Rebootstrap input was not enabled');
    return { downloaded: false, reason: 'explicit-manual-rebootstrap' };
  }
  if (commit === 'absent') {
    assertCollectionContext(env);
    return { downloaded: false, reason: 'no-data-branch' };
  }
  if (commit === undefined) {
    const api = request ?? githubRequest();
    const previous = await api('GET', 'git/ref/heads/data', undefined, true);
    if (!previous) return { downloaded: false, reason: 'no-data-branch' };
    commit = previous.object?.sha;
  }
  const sha = commitSha(commit);
  const get = fetchFile ?? (async (filename, limit) => {
    const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${sha}/v1/conferences/${conference}/${filename}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), credentials: 'omit' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Previous snapshot download failed (HTTP ${response.status})`); }
    return limitedResponse(response, limit);
  });
  const manifestBytes = await get('manifest.json', MAX_MANIFEST_BYTES), manifest = await validateManifest(parsePublicJson(manifestBytes), conference, { allowOld: true });
  const schoolBytes = new Map();
  for (let offset = 0; offset < manifest.schools.length; offset += 4) await Promise.all(manifest.schools.slice(offset, offset + 4).map(async entry => schoolBytes.set(entry.slug, await get(entry.path, MAX_FILE_BYTES))));
  const bundle = await validateFiles(manifestBytes, schoolBytes, conference, { validator, allowOld: true });
  await mkdir(directory, { recursive: true });
  const root = await checkedDirectory(directory);
  assert.equal((await readdir(root)).length, 0, 'Previous-snapshot directory must be empty');
  await mkdir(path.join(root, 'v1', 'conferences', conference, 'schools'), { recursive: true });
  for (const file of bundle.files) await writeFile(path.join(root, file.path), file.content, { flag: 'wx', mode: 0o600 });
  return { downloaded: true, sha };
}
async function main() {
  const { values } = parseArgs({ options: { conference: { type: 'string' }, output: { type: 'string', default: 'previous' }, commit: { type: 'string' }, rebootstrap: { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
  console.log(JSON.stringify(await downloadPrevious(values.conference, values.output, { commit: values.commit, rebootstrap: values.rebootstrap })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Previous snapshots unavailable: ${error.message}`); process.exitCode = 1; });
