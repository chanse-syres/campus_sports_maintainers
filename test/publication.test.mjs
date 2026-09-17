import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSchools, loadCatalog, COLLECTIONS } from '../src/config.mjs';
import { emptyDataset } from '../src/dataset.mjs';
import { digest, validateManifest, validatePublicIndex, expectedPublicIndex } from '../src/manifest.mjs';
import { assertPublishContext, loadPublicationBundle, publishBundles, REPOSITORY } from '../scripts/publish.mjs';
import { downloadPrevious } from '../scripts/download-previous.mjs';
import { resolveDataCommit } from '../scripts/resolve-data-ref.mjs';
import { readPublishedSchool } from '../examples/read-school.mjs';

const conference = 'ivy-league';
const mainSha = 'a'.repeat(40), parentSha = 'b'.repeat(40), oldTree = 'c'.repeat(40), newTree = 'd'.repeat(40), newCommit = 'e'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/maintainers.yml@refs/heads/main`, GITHUB_SHA: mainSha, GITHUB_TOKEN: 'synthetic-test-value' };
const cp = value => ({ slug: value.slug, name: value.name });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'campus-publish-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('campus-publish-') && path.dirname(root) === path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const schools = await listSchools(conference), catalog = await loadCatalog(), at = new Date().toISOString();
  const selected = path.join(root, 'v1', 'conferences', conference), schoolBytes = new Map();
  await mkdir(path.join(selected, 'schools'), { recursive: true });
  const manifest = { schemaVersion: 1, academicYear: catalog.academicYear, conference: cp(schools[0].conference), generatedAt: at, schools: [] };
  for (const school of schools) {
    const sports = Object.fromEntries(school.sports.map(sport => [sport.slug, {
      sponsored: true, code: sport.code, name: sport.name, gender: sport.gender, conference: cp(sport.conference),
      ...Object.fromEntries(COLLECTIONS.map(kind => [kind, { ...emptyDataset(at, 'unavailable', 'no-reviewed-source'), ...(kind === 'news' ? { sources: [] } : {}) }])),
    }]));
    const snapshot = { schemaVersion: 1, academicYear: catalog.academicYear, conference: cp(school.conference), school: { slug: school.slug, ncaaId: String(school.ncaaId), name: school.name, athleticsUrl: school.athleticsUrl, membershipSourceUrl: school.sourceUrl }, generatedAt: at, sports };
    const bytes = Buffer.from(JSON.stringify(snapshot) + '\n');
    schoolBytes.set(school.slug, bytes);
    manifest.schools.push({ slug: school.slug, path: `schools/${school.slug}.json`, sha256: digest(bytes), bytes: bytes.length });
    await writeFile(path.join(selected, 'schools', `${school.slug}.json`), bytes);
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await writeFile(path.join(selected, 'manifest.json'), manifestBytes);
  return { root, selected, schools, schoolBytes, manifest, manifestBytes };
}
function apiMock({ initial = parentSha, failPatch = false, advanceMain = false } = {}) {
  const calls = []; let current = initial, mainReads = 0;
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === 'git/ref/heads/main') return { object: { sha: advanceMain && mainReads++ ? 'f'.repeat(40) : mainSha } };
    if (endpoint === 'git/ref/heads/data') return current ? { object: { sha: current } } : null;
    if (endpoint === `git/commits/${parentSha}`) return { tree: { sha: oldTree } };
    if (endpoint === 'git/trees') return { sha: newTree };
    if (endpoint === 'git/commits') return { sha: newCommit };
    if (endpoint === 'git/refs/heads/data') { if (failPatch) throw new Error('Concurrent non-fast-forward writer'); current = body.sha; return {}; }
    if (endpoint === 'git/refs') { current = body.sha; return {}; }
    throw new Error(`Unexpected test request ${method} ${endpoint}`);
  };
  return { request, calls };
}

test('conference bundle accepts only the complete exact catalog with matching hashes', async t => {
  const f = await fixture(t), bundle = await loadPublicationBundle(f.root, conference);
  assert.equal(bundle.files.length, f.schools.length + 1);
  assert.equal(bundle.manifest.conference.slug, conference);
  const target = path.join(f.selected, 'schools', `${f.schools[0].slug}.json`);
  const bytes = await readFile(target);
  await writeFile(target, Buffer.from(bytes.toString().replace('no-reviewed-source', 'no-reviewed-xxxxx')));
  await assert.rejects(loadPublicationBundle(f.root, conference), /checksum|bytes/);
});
test('manifests reject traversal, missing schools, foreign conferences, future and stale collection dates', async t => {
  const f = await fixture(t);
  const traversal = structuredClone(f.manifest); traversal.schools[0].path = '../other.json';
  await assert.rejects(validateManifest(traversal, conference), /path mismatch/);
  const missing = structuredClone(f.manifest); missing.schools.pop();
  await assert.rejects(validateManifest(missing, conference), /exactly the configured/);
  const foreign = structuredClone(f.manifest); foreign.conference.slug = 'big-12';
  await assert.rejects(validateManifest(foreign, conference), /conference mismatch/);
  const future = structuredClone(f.manifest); future.generatedAt = new Date(Date.now() + 3600_000).toISOString();
  await assert.rejects(validateManifest(future, conference), /future/);
  const old = structuredClone(f.manifest); old.generatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
  await assert.rejects(validateManifest(old, conference), /older than/);
  await validateManifest(old, conference, { allowOld: true });
});
test('publication directories reject extra files and hardlinked snapshots', async t => {
  const f = await fixture(t), extra = path.join(f.selected, 'secret.env');
  await writeFile(extra, 'synthetic forbidden file');
  await assert.rejects(loadPublicationBundle(f.root, conference), /Unexpected conference files/);
  await rm(extra);
  const source = path.join(f.selected, 'schools', `${f.schools[0].slug}.json`), alias = path.join(f.root, 'alias');
  await link(source, alias);
  await assert.rejects(loadPublicationBundle(f.root, conference), /Only the v1/);
  // Keep a second hardlink outside the publication root, so the file-link check runs.
  const external = `${f.root}-link`;
  await link(source, external);
  t.after(() => rm(external, { force: true }));
  await rm(alias);
  await assert.rejects(loadPublicationBundle(f.root, conference), /ordinary files/);
});
test('public index is exactly the catalog, including per-sport affiliations', async () => {
  const index = await expectedPublicIndex(); await validatePublicIndex(index);
  index.schools[0].path = 'https://untrusted.example/data';
  await assert.rejects(validatePublicIndex(index), /differs from/);
});
test('publication rejects fork, PR, wrong-workflow, and local contexts before remote access', async () => {
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'attacker/fork' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` }, { GITHUB_TOKEN: '' }]) assert.throws(() => assertPublishContext({ ...env, ...patch }));
  await assert.rejects(publishBundles([{ files: [{ path: 'unsafe' }] }], { env }), /validated bundles/);
});
test('publisher preserves other conference trees and advances the data ref without force', async t => {
  const f = await fixture(t), bundle = await loadPublicationBundle(f.root, conference), api = apiMock();
  const result = await publishBundles([bundle], { env, conference, request: api.request, pause: async () => {} });
  assert.deepEqual(result, { changed: true, sha: newCommit });
  const tree = api.calls.find(c => c.endpoint === 'git/trees');
  assert.equal(tree.body.base_tree, oldTree);
  assert.ok(tree.body.tree.every(entry => entry.path === 'v1/index.json' || entry.path.startsWith(`v1/conferences/${conference}/`)));
  const commit = api.calls.find(c => c.endpoint === 'git/commits');
  assert.deepEqual(commit.body.parents, [parentSha]);
  assert.deepEqual(api.calls.find(c => c.method === 'PATCH').body, { sha: newCommit, force: false });
  assert.equal(api.calls.filter(c => c.endpoint === 'git/ref/heads/main').length, 2);
});
test('scheduled publisher rejects a partial bundle before any remote operation', async t => {
  const f = await fixture(t), bundle = await loadPublicationBundle(f.root, conference);
  let calls = 0;
  await assert.rejects(publishBundles([bundle], { env: { ...env, GITHUB_EVENT_NAME: 'schedule' }, request: async () => { calls++; throw new Error('Must not contact GitHub'); }, pause: async () => {} }), /Scheduled publication requires every conference/);
  await assert.rejects(publishBundles([bundle], { env: { ...env, GITHUB_EVENT_NAME: 'schedule' }, conference, request: async () => { calls++; throw new Error('Must not contact GitHub'); }, pause: async () => {} }), /does not accept a conference selector/);
  assert.equal(calls, 0);
});
test('manual partial publisher requires the exact explicitly requested catalog conference', async t => {
  const f = await fixture(t), bundle = await loadPublicationBundle(f.root, conference);
  let calls = 0;
  const request = async () => { calls++; throw new Error('Must not contact GitHub'); };
  await assert.rejects(publishBundles([bundle], { env, request }), /partial publication needs an explicit selector/);
  await assert.rejects(publishBundles([bundle], { env, request, conference: 'southeastern' }), /exactly the requested conference/);
  await assert.rejects(publishBundles([bundle], { env, request, conference: '../ivy-league' }), /Unknown publication conference selector/);
  assert.equal(calls, 0);
});
test('first publication creates an orphan data branch from validated files only', async t => {
  const f = await fixture(t), api = apiMock({ initial: null });
  await publishBundles([await loadPublicationBundle(f.root, conference)], { env, conference, request: api.request, pause: async () => {} });
  assert.ok(!('base_tree' in api.calls.find(c => c.endpoint === 'git/trees').body));
  assert.deepEqual(api.calls.find(c => c.endpoint === 'git/commits').body.parents, []);
  assert.deepEqual(api.calls.find(c => c.endpoint === 'git/refs').body, { ref: 'refs/heads/data', sha: newCommit });
});
test('concurrent writers and code updates stop publication instead of force-overwriting', async t => {
  const f = await fixture(t), bundle = await loadPublicationBundle(f.root, conference);
  const conflict = apiMock({ failPatch: true });
  await assert.rejects(publishBundles([bundle], { env, conference, request: conflict.request, pause: async () => {} }), /Concurrent/);
  assert.equal(conflict.calls.filter(c => c.method === 'PATCH').length, 1);
  const advanced = apiMock({ advanceMain: true });
  await assert.rejects(publishBundles([bundle], { env, conference, request: advanced.request, pause: async () => {} }), /Main advanced/);
  assert.ok(!advanced.calls.some(c => c.method === 'PATCH'));
});
test('previous download permits only a missing branch, and validates all existing files before writing', async t => {
  const f = await fixture(t), target = path.join(f.root, 'previous');
  assert.deepEqual(await downloadPrevious(conference, target, { request: async () => null }), { downloaded: false, reason: 'no-data-branch' });
  const request = async () => ({ object: { sha: parentSha } });
  await assert.rejects(downloadPrevious(conference, target, { request, fetchFile: async () => { throw new Error('HTTP 404'); } }), /HTTP 404/);
  const fetchFile = async filename => filename === 'manifest.json' ? f.manifestBytes : f.schoolBytes.get(path.basename(filename, '.json'));
  assert.deepEqual(await downloadPrevious(conference, target, { request, fetchFile }), { downloaded: true, sha: parentSha });
  assert.equal((await loadPublicationBundle(target, conference)).manifest.schools.length, f.schools.length);
  await assert.rejects(downloadPrevious(conference, target, { request, fetchFile }), /must be empty/);
});
test('prepare resolves one public commit and pinned collectors make no GitHub API calls', async t => {
  const f = await fixture(t); let lookups = 0;
  const sha = await resolveDataCommit({ request: async (method, endpoint, body, allowMissing) => {
    lookups++; assert.equal(method, 'GET'); assert.equal(endpoint, 'git/ref/heads/data'); assert.equal(body, undefined); assert.equal(allowMissing, true);
    return { object: { sha: parentSha } };
  } });
  assert.equal(lookups, 1); assert.equal(sha, parentSha);
  const fetchFile = async filename => filename === 'manifest.json' ? f.manifestBytes : f.schoolBytes.get(path.basename(filename, '.json'));
  const result = await downloadPrevious(conference, path.join(f.root, 'pinned'), { commit: sha, fetchFile, request: async () => { throw new Error('Collector must not perform an API lookup'); } });
  assert.equal(result.sha, parentSha);
  await assert.rejects(downloadPrevious(conference, 'unused', { commit: '../main' }), /invalid commit/);
  assert.equal(await resolveDataCommit({ request: async () => null }), 'absent');
  await assert.rejects(resolveDataCommit({ request: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
});
test('absent sentinel is trusted-workflow-only and rebootstrap is an explicit manual input', async () => {
  const request = async () => { throw new Error('No API lookup expected'); };
  await assert.rejects(downloadPrevious(conference, 'unused', { commit: 'absent', request, env: {} }), /Bootstrap requires/);
  assert.deepEqual(await downloadPrevious(conference, 'unused', { commit: 'absent', request, env }), { downloaded: false, reason: 'no-data-branch' });
  await assert.rejects(downloadPrevious(conference, 'unused', { commit: parentSha, rebootstrap: true, request, env }), /input was not enabled/);
  await assert.rejects(downloadPrevious(conference, 'unused', { rebootstrap: true, request, env: { ...env, GITHUB_EVENT_NAME: 'schedule', MAINTAINER_REBOOTSTRAP: 'true' } }), /explicit manual run/);
  assert.deepEqual(await downloadPrevious(conference, 'unused', { commit: parentSha, rebootstrap: true, request, env: { ...env, MAINTAINER_REBOOTSTRAP: 'true' } }), { downloaded: false, reason: 'explicit-manual-rebootstrap' });
});
test('consumer pins one commit and rejects a mismatched school file', async t => {
  const f = await fixture(t), slug = f.schools[0].slug, requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (new URL(url).hostname === 'api.github.com') return new Response(JSON.stringify({ object: { sha: parentSha } }));
    if (url.endsWith('/manifest.json')) return new Response(f.manifestBytes);
    return new Response(f.schoolBytes.get(slug));
  };
  const result = await readPublishedSchool(slug, { fetchImpl });
  assert.equal(result.commit, parentSha); assert.equal(result.school.slug, slug);
  assert.ok(requests.slice(1).every(url => url.includes(`/${parentSha}/`)));
  assert.ok(Object.values(result.news).every(news => news.fresh === false));
  await assert.rejects(readPublishedSchool(slug, { commit: parentSha, fetchImpl: async url => new Response(url.endsWith('/manifest.json') ? f.manifestBytes : f.schoolBytes.get(f.schools[1].slug)) }), /size mismatch|integrity/);
  await assert.rejects(readPublishedSchool('../private', { fetchImpl: async () => { throw new Error('must not fetch'); } }), /Unknown school/);
});
test('workflows pin actions and isolate publication credentials from collection', async () => {
  const workflow = await readFile(new URL('../.github/workflows/maintainers.yml', import.meta.url), 'utf8');
  const [beforePublish, publication] = workflow.split('\n  publish:\n');
  const [prepare, collection] = beforePublish.split('\n  collect:\n');
  assert.match(collection, /max-parallel: 4/);
  assert.ok(!collection.includes('contents: write') && !collection.includes('GITHUB_TOKEN:') && !collection.includes('secrets.'));
  assert.ok(!prepare.includes('contents: write'));
  assert.equal((prepare.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
  assert.match(prepare, /node scripts\/resolve-data-ref.mjs/);
  assert.match(collection, /--commit "\$DATA_COMMIT"/);
  assert.match(publication, /contents: write/);
  assert.equal((publication.match(/GITHUB_TOKEN:/g) ?? []).length, 1);
  assert.ok(!workflow.includes('pull_request_target'));
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
});
