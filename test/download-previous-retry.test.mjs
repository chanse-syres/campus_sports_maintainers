import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadPrevious } from '../scripts/download-previous.mjs';
import { listSchools, loadCatalog, COLLECTIONS, REPOSITORY } from '../src/config.mjs';
import { emptyDataset } from '../src/dataset.mjs';
import { digest, MAX_MANIFEST_BYTES } from '../src/manifest.mjs';

const conference = 'ivy-league', commit = 'a'.repeat(40);
const base = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/v1/conferences/${conference}/`;
const identity = value => ({ slug: value.slug, name: value.name });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'campus-previous-retry-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('campus-previous-retry-'));
    await rm(root, { recursive: true, force: true });
  });
  const schools = await listSchools(conference), catalog = await loadCatalog(), at = new Date().toISOString(), files = new Map();
  const manifest = { schemaVersion: 1, academicYear: catalog.academicYear, conference: identity(schools[0].conference), generatedAt: at, schools: [] };
  for (const school of schools) {
    const snapshot = { schemaVersion: 1, academicYear: catalog.academicYear, conference: identity(school.conference), school: { slug: school.slug, ncaaId: String(school.ncaaId), name: school.name, athleticsUrl: school.athleticsUrl, membershipSourceUrl: school.sourceUrl }, generatedAt: at,
      sports: Object.fromEntries(school.sports.map(sport => [sport.slug, { sponsored: true, code: sport.code, name: sport.name, gender: sport.gender, conference: identity(sport.conference), ...Object.fromEntries(COLLECTIONS.map(kind => [kind, { ...emptyDataset(at, 'unavailable', 'no-reviewed-source'), ...(kind === 'news' ? { sources: [] } : {}) }])) }])) };
    const bytes = Buffer.from(JSON.stringify(snapshot)), filename = `schools/${school.slug}.json`;
    files.set(filename, bytes);
    manifest.schools.push({ slug: school.slug, path: filename, sha256: digest(bytes), bytes: bytes.length });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return { root, target: path.join(root, 'previous'), files, manifest };
}
function mockFetch(t, f, intercept = () => undefined) {
  const calls = new Map(), options = [], pauses = [];
  t.mock.method(globalThis, 'fetch', async (url, settings) => {
    assert.ok(url.startsWith(base), 'Only the fixed commit-pinned raw GitHub URL is requested');
    assert.equal(settings.redirect, 'error');
    assert.equal(settings.credentials, 'omit');
    assert.ok(settings.signal instanceof AbortSignal);
    options.push(settings);
    const filename = url.slice(base.length), attempt = (calls.get(filename) ?? 0) + 1;
    calls.set(filename, attempt);
    const response = await intercept(filename, attempt);
    return response ?? new Response(f.files.get(filename), { status: 200 });
  });
  return { calls, options, pauses, pause: async ms => { pauses.push(ms); } };
}
const absent = target => assert.rejects(stat(target), { code: 'ENOENT' });

test('one 503 retries the identical pinned request then writes the validated complete bundle', async t => {
  const f = await fixture(t); let canceled = 0;
  const failure = new Response('temporary', { status: 503 });
  t.mock.method(failure.body, 'cancel', async () => { canceled++; });
  const mock = mockFetch(t, f, (file, attempt) => file === 'manifest.json' && attempt === 1 ? failure : undefined);
  assert.deepEqual(await downloadPrevious(conference, f.target, { commit, pause: mock.pause }), { downloaded: true, sha: commit });
  assert.equal(mock.calls.get('manifest.json'), 2);
  assert.deepEqual(mock.pauses, [1000]);
  assert.equal(canceled, 1);
  assert.notEqual(mock.options[0].signal, mock.options[1].signal);
  assert.deepEqual(await readFile(path.join(f.target, 'v1', 'conferences', conference, 'manifest.json')), f.files.get('manifest.json'));
});

test('a repeated 503 stops after two attempts without creating an output directory', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response('temporary', { status: 503 }));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /HTTP 503/);
  assert.equal(mock.calls.get('manifest.json'), 2);
  assert.deepEqual(mock.pauses, [1000]);
  await absent(f.target);
});

test('a request timeout retries once and succeeds', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, (file, attempt) => { if (file === 'manifest.json' && attempt === 1) throw new DOMException('Timed out', 'TimeoutError'); });
  await downloadPrevious(conference, f.target, { commit, pause: mock.pause });
  assert.equal(mock.calls.get('manifest.json'), 2);
  assert.deepEqual(mock.pauses, [1000]);
});

test('transient socket failure during a school response retries only that file', async t => {
  const f = await fixture(t), targetFile = f.manifest.schools[0].path;
  const mock = mockFetch(t, f, (file, attempt) => {
    if (file === targetFile && attempt === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })); } }));
  });
  await downloadPrevious(conference, f.target, { commit, pause: mock.pause });
  assert.equal(mock.calls.get(targetFile), 2);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, [1000]);
});

for (const status of [400, 403, 404, 429]) test(`HTTP ${status} is not retried`, async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response('unavailable', { status }));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), new RegExp(`HTTP ${status}`));
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('unsafe redirects and unclassified fetch errors are not retried', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /fetch failed/);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('response size violations are not retried or written', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response('oversized', { headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) } }));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /size limits/);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('malformed JSON and closed-manifest schema violations are never retried', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response('{invalid json'));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /Malformed public JSON/);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('manifest schema violations are never retried', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response(JSON.stringify({ ...f.manifest, unreviewed: true })));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /unexpected or missing fields/);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('a school checksum failure never retries or writes any partially downloaded bundle', async t => {
  const f = await fixture(t), targetFile = f.manifest.schools[0].path;
  const corrupted = Buffer.from(f.files.get(targetFile)); corrupted[0] = 32;
  const mock = mockFetch(t, f, file => file === targetFile ? new Response(corrupted) : undefined);
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /checksum/);
  assert.equal(mock.calls.get(targetFile), 1);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('streamed size overflow is not retried when content-length is absent', async t => {
  const f = await fixture(t), mock = mockFetch(t, f, () => new Response(Buffer.alloc(MAX_MANIFEST_BYTES + 1)));
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /size limits/);
  assert.equal(mock.calls.get('manifest.json'), 1);
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});

test('a school schema failure with matching checksum never triggers a transport retry', async t => {
  const f = await fixture(t), entry = f.manifest.schools[0];
  const snapshot = JSON.parse(f.files.get(entry.path)); snapshot.unreviewed = true;
  const bytes = Buffer.from(JSON.stringify(snapshot));
  f.files.set(entry.path, bytes); entry.bytes = bytes.length; entry.sha256 = digest(bytes);
  f.files.set('manifest.json', Buffer.from(JSON.stringify(f.manifest)));
  const mock = mockFetch(t, f);
  await assert.rejects(downloadPrevious(conference, f.target, { commit, pause: mock.pause }), /Invalid snapshot/);
  assert.ok([...mock.calls.values()].every(count => count === 1));
  assert.deepEqual(mock.pauses, []);
  await absent(f.target);
});
