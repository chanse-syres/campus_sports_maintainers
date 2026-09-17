import { readFile } from 'node:fs/promises';
import { safeUrl } from './normalize.mjs';

export const REPOSITORY = 'chanse-syres/campus_sports_maintainers';
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COLLECTIONS = Object.freeze(['news', 'schedule', 'roster', 'recruitingAnnouncements', 'recruitingBoard', 'recruitingOffers']);
let catalogPromise;
export async function loadCatalog() {
  catalogPromise ??= readFile(new URL('../catalog/membership.json', import.meta.url), 'utf8').then(JSON.parse).then(catalog => {
    if (!Array.isArray(catalog.schools) || catalog.schools.length < 300 || catalog.schools.length > 500) throw new Error('Invalid Division I catalog');
    const ids = new Set(), slugs = new Set();
    for (const school of catalog.schools) {
      if (!SLUG.test(school.slug) || slugs.has(school.slug) || ids.has(String(school.ncaaId)) || !SLUG.test(school.conference?.slug)) throw new Error('Invalid or duplicate catalog school');
      if (school.athleticsUrl !== null && !safeUrl(school.athleticsUrl)) throw new Error('Unsafe athletics URL');
      if (!Array.isArray(school.sports) || !school.sports.length || school.sports.length > 60) throw new Error('Invalid sponsorship');
      const sports = new Set();
      for (const sport of school.sports) {
        if (!SLUG.test(sport.slug) || sports.has(sport.slug) || !SLUG.test(sport.conference?.slug)) throw new Error('Invalid or duplicate sport');
        sports.add(sport.slug);
      }
      slugs.add(school.slug); ids.add(String(school.ncaaId));
    }
    return catalog;
  });
  return catalogPromise;
}
export async function listSchools(conference) {
  const schools = (await loadCatalog()).schools;
  if (conference !== undefined && !schools.some(s => s.conference.slug === conference)) throw new Error('Unknown primary conference');
  return schools.filter(s => !conference || s.conference.slug === conference);
}
export async function getSchool(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('Unknown school');
  const school = (await listSchools()).find(s => s.slug === slug);
  if (!school) throw new Error('Unknown school');
  return school;
}
export async function listConferences() {
  return [...new Map((await listSchools()).map(s => [s.conference.slug, s.conference])).values()].sort((a,b) => a.slug.localeCompare(b.slug));
}
export function getSport(school, slug) {
  const sport = school.sports.find(s => s.slug === slug);
  if (!sport) throw new Error('School does not sponsor this sport');
  return sport;
}
let sourcesPromise;
export async function loadSources() {
  sourcesPromise ??= readFile(new URL('../catalog/sources.json', import.meta.url), 'utf8').then(JSON.parse).catch(error=>{
    if(error.code==='ENOENT')return {schemaVersion:1,schools:{}};
    throw error;
  });
  return sourcesPromise;
}
