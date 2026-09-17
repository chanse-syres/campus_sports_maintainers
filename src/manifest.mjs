import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listConferences, listSchools, loadCatalog, SLUG } from './config.mjs';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export function parsePublicJson(bytes) {
  try { return JSON.parse(typeof bytes === 'string' ? bytes : decode(bytes)); }
  catch { throw new Error('Malformed public JSON document; contents withheld'); }
}
export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unexpected or missing fields`);
}
export async function validateManifest(manifest, conferenceSlug, { now = Date.now(), allowOld = false } = {}) {
  assert.ok(typeof conferenceSlug === 'string' && SLUG.test(conferenceSlug), 'Invalid conference slug');
  const schools = await listSchools(conferenceSlug), catalog = await loadCatalog();
  const conference = schools[0].conference;
  exactKeys(manifest, ['schemaVersion', 'academicYear', 'conference', 'generatedAt', 'schools'], 'manifest');
  assert.equal(manifest.schemaVersion, 1, 'Unsupported manifest version');
  assert.equal(manifest.academicYear, catalog.academicYear, 'Manifest academic year differs from catalog');
  exactKeys(manifest.conference, ['slug', 'name'], 'manifest conference');
  assert.equal(manifest.conference.slug, conferenceSlug, 'Manifest conference mismatch');
  assert.equal(manifest.conference.name, conference.name, 'Manifest conference name mismatch');
  assert.ok(typeof manifest.generatedAt === 'string' && Number.isFinite(Date.parse(manifest.generatedAt)), 'Invalid manifest timestamp');
  assert.equal(new Date(manifest.generatedAt).toISOString(), manifest.generatedAt, 'Noncanonical manifest timestamp');
  const age = now - Date.parse(manifest.generatedAt);
  assert.ok(age >= -5 * 60_000, 'Manifest timestamp is in the future');
  if (!allowOld) assert.ok(age <= 24 * 60 * 60_000, 'Collection is older than 24 hours; recollect before publication');
  assert.ok(Array.isArray(manifest.schools), 'Manifest schools must be an array');
  assert.deepEqual(manifest.schools.map(s => s.slug).sort(), schools.map(s => s.slug).sort(), 'Manifest must contain exactly the configured conference schools');
  for (const entry of manifest.schools) {
    exactKeys(entry, ['slug', 'path', 'sha256', 'bytes'], 'manifest school');
    assert.equal(entry.path, `schools/${entry.slug}.json`, 'Manifest school path mismatch');
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, 'Invalid snapshot checksum');
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_FILE_BYTES, 'Invalid snapshot byte count');
  }
  return manifest;
}

export async function expectedPublicIndex() {
  const catalog = await loadCatalog(), conferences = await listConferences();
  return { schemaVersion: 1, academicYear: catalog.academicYear, membershipRetrievedAt: catalog.retrievedAt, sourceUrl: catalog.sourceUrl,
    conferences: conferences.map(c => ({ slug: c.slug, name: c.name, manifestPath: `v1/conferences/${c.slug}/manifest.json` })),
    schools: catalog.schools.map(s => ({ slug: s.slug, ncaaId: s.ncaaId, name: s.name, conference: s.conference.slug, path: `v1/conferences/${s.conference.slug}/schools/${s.slug}.json`, sports: s.sports.map(p => ({ slug: p.slug, code: p.code, conference: p.conference.slug })) })) };
}
export async function validatePublicIndex(index) {
  assert.deepEqual(index, await expectedPublicIndex(), 'Public index differs from the reviewed catalog');
  return index;
}

export async function limitedResponse(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null) assert.ok(Number.isFinite(Number(length)) && Number(length) <= limit, 'Remote response exceeds size limits');
  let total = 0; const parts = [];
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > limit) throw new Error('Remote response exceeds size limits');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
