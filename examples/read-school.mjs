// Server-side consumer example: pin one data commit, verify its manifest, then
// render links/cards from the normalized news records. No site credential needed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchool, REPOSITORY } from '../src/config.mjs';
import { parsePublicJson, digest, limitedResponse, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, validateManifest } from '../src/manifest.mjs';
import { validateSnapshot } from '../src/validate.mjs';

export async function readPublishedSchool(slug, { fetchImpl = fetch, commit, now = Date.now(), maxAgeMs = 12 * 60 * 60_000 } = {}) {
  const school = await getSchool(slug);
  const get = async (url, limit) => {
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Public data request failed (HTTP ${response.status})`); }
    return limitedResponse(response, limit);
  };
  if (!commit) commit = parsePublicJson(await get(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/data`, 64 * 1024)).object?.sha;
  assert.ok(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit), 'Invalid data commit');
  const base = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/v1/conferences/${school.conference.slug}/`;
  const manifest = await validateManifest(parsePublicJson(await get(`${base}manifest.json`, MAX_MANIFEST_BYTES)), school.conference.slug, { now, allowOld: true });
  const entry = manifest.schools.find(item => item.slug === slug);
  const bytes = await get(`${base}${entry.path}`, MAX_FILE_BYTES);
  assert.equal(bytes.length, entry.bytes, 'School snapshot size mismatch');
  assert.equal(digest(bytes), entry.sha256, 'School snapshot integrity check failed');
  const snapshot = await validateSnapshot(parsePublicJson(bytes), slug);
  assert.equal(snapshot.generatedAt, manifest.generatedAt, 'Snapshot generation differs from manifest');
  assert.equal(snapshot.academicYear, manifest.academicYear, 'Snapshot academic year differs from manifest');
  const news = Object.fromEntries(Object.entries(snapshot.sports).map(([sport, program]) => [sport, {
    name: program.name, conference: program.conference, ...program.news,
    fresh: ['ok', 'empty'].includes(program.news.status) && program.news.lastSuccessAt !== null && now - Date.parse(program.news.lastSuccessAt) <= maxAgeMs,
  }]));
  return { commit, school: snapshot.school, conference: snapshot.conference, generatedAt: snapshot.generatedAt, staleSnapshot: now - Date.parse(snapshot.generatedAt) > maxAgeMs, news };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readPublishedSchool(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
