import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPOSITORY, listConferences, listSchools } from '../src/config.mjs';
import { validateSnapshot } from '../src/validate.mjs';
import { MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_BUNDLE_BYTES, decode, digest, limitedResponse, parsePublicJson, validateManifest, validatePublicIndex } from '../src/manifest.mjs';

export { REPOSITORY };
const validatedBundles = new WeakSet();
const DATA_BRANCH = 'data';
const MAX_TREE_REQUEST = 4 * 1024 * 1024;
export function commitSha(value) {
  assert.ok(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'GitHub returned an invalid commit or tree identifier');
  return value;
}
export async function checkedDirectory(directory, parent) {
  const metadata = await lstat(directory);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Publication directories must be real directories');
  const resolved = await realpath(directory);
  if (parent) assert.equal(path.dirname(resolved), parent, 'Publication directory escapes its parent');
  return resolved;
}
export async function readRegularFile(directory, filename, limit) {
  const target = path.join(directory, filename), metadata = await lstat(target);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, 'Publication files must be ordinary files, never links');
  assert.ok(metadata.size > 0 && metadata.size <= limit, 'Publication file exceeds size limits');
  assert.equal(path.dirname(await realpath(target)), directory, 'Publication file escapes its directory');
  const bytes = await readFile(target);
  assert.ok(bytes.length > 0 && bytes.length <= limit, 'Publication file exceeds size limits');
  return bytes;
}
export async function validateFiles(manifestBytes, schoolBytes, conference, options = {}) {
  assert.ok(manifestBytes.length > 0 && manifestBytes.length <= MAX_MANIFEST_BYTES, 'Manifest exceeds size limits');
  const manifest = await validateManifest(parsePublicJson(manifestBytes), conference, options);
  const prefix = `v1/conferences/${conference}`;
  let total = manifestBytes.length;
  const files = [{ path: `${prefix}/manifest.json`, content: decode(manifestBytes) }];
  for (const entry of manifest.schools) {
    const bytes = schoolBytes.get(entry.slug);
    assert.ok(bytes && bytes.length === entry.bytes && bytes.length <= MAX_FILE_BYTES, 'Missing or mismatched school snapshot bytes');
    total += bytes.length;
    assert.ok(total <= MAX_BUNDLE_BYTES, 'Conference bundle exceeds total size limit');
    assert.equal(digest(bytes), entry.sha256, 'School snapshot checksum does not match manifest');
    const content = decode(bytes), snapshot = parsePublicJson(content);
    await (options.validator ?? validateSnapshot)(snapshot, entry.slug);
    assert.equal(snapshot.conference.slug, conference, 'School snapshot conference mismatch');
    assert.equal(snapshot.academicYear, manifest.academicYear, 'School snapshot academic year mismatch');
    assert.equal(snapshot.generatedAt, manifest.generatedAt, 'School snapshot generation differs from manifest');
    files.push({ path: `${prefix}/${entry.path}`, content });
  }
  const bundle = Object.freeze({ manifest: Object.freeze(manifest), files: Object.freeze(files.map(Object.freeze)) });
  validatedBundles.add(bundle);
  return bundle;
}
export async function loadPublicationBundle(directory = 'output', conference, options = {}) {
  const schools = await listSchools(conference);
  assert.ok(typeof conference === 'string', 'Conference is required');
  const root = await checkedDirectory(directory);
  assert.deepEqual((await readdir(root)).sort(), ['v1'], 'Only the v1 publication directory is allowed');
  const version = await checkedDirectory(path.join(root, 'v1'), root);
  assert.deepEqual(await readdir(version), ['conferences'], 'Unexpected publication version files');
  const conferences = await checkedDirectory(path.join(version, 'conferences'), version);
  const known = new Set((await listConferences()).map(c => c.slug));
  for (const name of await readdir(conferences)) assert.ok(known.has(name), 'Unknown conference directory');
  const selected = await checkedDirectory(path.join(conferences, conference), conferences);
  assert.deepEqual((await readdir(selected)).sort(), ['manifest.json', 'schools'], 'Unexpected conference files');
  const schoolDirectory = await checkedDirectory(path.join(selected, 'schools'), selected);
  assert.deepEqual((await readdir(schoolDirectory)).sort(), schools.map(s => `${s.slug}.json`).sort(), 'Unexpected or missing school files');
  const manifestBytes = await readRegularFile(selected, 'manifest.json', MAX_MANIFEST_BYTES), schoolBytes = new Map();
  for (const school of schools) schoolBytes.set(school.slug, await readRegularFile(schoolDirectory, `${school.slug}.json`, MAX_FILE_BYTES));
  return validateFiles(manifestBytes, schoolBytes, conference, options);
}
export function githubRequest(token) {
  return async (method, endpoint, body, allowMissing = false) => {
    assert.ok(/^[a-zA-Z0-9_./-]+$/.test(endpoint) && !endpoint.includes('..'), 'Unsafe GitHub endpoint');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'campus-sports-maintainers' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30_000), credentials: 'omit' });
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub ${method} failed (HTTP ${response.status}); response body withheld`); }
    return parsePublicJson(await limitedResponse(response, 2 * 1024 * 1024));
  };
}
export function assertPublishContext(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Live publication requires GitHub Actions');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected publication repository');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Publication is restricted to main');
  assert.ok(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unexpected publication event');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/maintainers.yml@refs/heads/main`, 'Unexpected publication workflow');
  commitSha(env.GITHUB_SHA);
  assert.ok(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length, 'Publication token unavailable');
}

export async function publishBundles(bundles, { env = process.env, request, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), indexPath = new URL('../public-index.json', import.meta.url) } = {}) {
  assertPublishContext(env);
  assert.ok(Array.isArray(bundles) && bundles.length && bundles.every(b => validatedBundles.has(b)), 'Publication requires validated bundles');
  assert.equal(new Set(bundles.map(b => b.manifest.conference.slug)).size, bundles.length, 'Duplicate conference bundle');
  const indexContent = await readFile(indexPath, 'utf8');
  await validatePublicIndex(parsePublicJson(indexContent));
  // Build this immutable file list before any remote mutation. Bodies never contain private data.
  const files = [...bundles.flatMap(b => b.files), { path: 'v1/index.json', content: indexContent }];
  const api = request ?? githubRequest(env.GITHUB_TOKEN);
  const assertCurrentMain = async () => assert.equal(commitSha((await api('GET', 'git/ref/heads/main')).object?.sha), env.GITHUB_SHA, 'Main advanced; recollect with current code');
  await assertCurrentMain();
  const previous = await api('GET', `git/ref/heads/${DATA_BRANCH}`, undefined, true);
  const parent = previous ? commitSha(previous.object?.sha) : null;
  let treeSha = parent ? commitSha((await api('GET', `git/commits/${parent}`)).tree?.sha) : null;
  const originalTree = treeSha;
  // Bounded inline trees avoid hundreds of blob writes and API content-creation limits.
  // Each tree uses the prior tree as its base, preserving conferences not selected this run.
  let entries = [], bytes = 0;
  const flush = async () => {
    if (!entries.length) return;
    const body = { ...(treeSha ? { base_tree: treeSha } : {}), tree: entries };
    const result = await api('POST', 'git/trees', body);
    treeSha = commitSha(result.sha); entries = []; bytes = 0;
    await pause(1000);
  };
  for (const file of files) {
    const entry = { path: file.path, mode: '100644', type: 'blob', content: file.content };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (size > MAX_TREE_REQUEST) {
      await flush();
      const blob = await api('POST', 'git/blobs', { content: file.content, encoding: 'utf-8' });
      entries.push({ path: file.path, mode: '100644', type: 'blob', sha: commitSha(blob.sha) });
      await pause(1000);
    } else {
      if (bytes + size > MAX_TREE_REQUEST) await flush();
      entries.push(entry); bytes += size;
    }
  }
  await flush();
  if (parent && treeSha === originalTree) return { changed: false, sha: parent };
  const commit = await api('POST', 'git/commits', { message: `Refresh validated public news for ${bundles.length} conferences`, tree: treeSha, parents: parent ? [parent] : [] });
  const sha = commitSha(commit.sha);
  await assertCurrentMain();
  if (parent) await api('PATCH', `git/refs/heads/${DATA_BRANCH}`, { sha, force: false });
  else await api('POST', 'git/refs', { ref: `refs/heads/${DATA_BRANCH}`, sha });
  assert.equal(commitSha((await api('GET', `git/ref/heads/${DATA_BRANCH}`)).object?.sha), sha, 'Published ref differs from validated commit');
  return { changed: true, sha };
}
async function main() {
  const { values } = parseArgs({ options: { conference: { type: 'string' }, output: { type: 'string', default: 'output' }, 'dry-run': { type: 'boolean' } }, strict: true, allowPositionals: false });
  const selected = values.conference ? [values.conference] : await readdir(path.join(values.output, 'v1', 'conferences'));
  assert.ok(selected.length, 'No conference bundles found');
  const bundles = [];
  for (const slug of selected.sort()) bundles.push(await loadPublicationBundle(values.output, slug));
  if (values['dry-run']) { console.log(`Validated ${bundles.length} conferences and ${bundles.reduce((n, b) => n + b.manifest.schools.length, 0)} schools; no publication performed.`); return; }
  // National workflow publication must contain all conferences; partial manual jobs use an explicit selector.
  if (!values.conference) assert.deepEqual(selected.sort(), (await listConferences()).map(c => c.slug).sort(), 'National publication requires every conference');
  console.log(JSON.stringify(await publishBundles(bundles)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Publication stopped: ${error.message}`); process.exitCode = 1; });
