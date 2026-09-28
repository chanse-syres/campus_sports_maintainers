import { assertCatalogScope } from '../providers.mjs';
import { parseSoconFootballNews } from './socon-news.mjs';
import { collectNecFootballNews } from './nec-news.mjs';

// Explicit replacements for university hosts that deny GitHub-hosted requests.
// These are independent official conference publications, not alternate routes
// to the denied hosts. Keep publisher attribution in the respective adapters.
export const conferenceFootballSources = Object.freeze({
  'central-connecticut-state-university': Object.freeze({
    ncaaId: '127', conference: 'northeast',
    url: 'https://necsports.com/archives.aspx?path=football',
    blockedSourceUrl: 'https://www.ccsubluedevils.com/sports/fball/2026-27/news',
    reason: 'University football archive and RSS deny GitHub requests with HTTP 405; use official NEC coverage.',
    collect: collectNecFootballNews,
  }),
  'tennessee-technological-university': Object.freeze({
    ncaaId: '692', conference: 'southern',
    url: 'https://soconsports.com/fb/',
    blockedSourceUrl: 'https://www.ttusports.com/sports/fball/headlines-featured',
    reason: 'University football archive and RSS deny GitHub requests with HTTP 405; use official SoCon coverage.',
    collect: parseSoconFootballNews,
  }),
});

export function conferenceFootballSource(school, sport) {
  if (sport.slug !== 'football' || !conferenceFootballSources[school.slug]) return null;
  const canonical = assertCatalogScope(school, sport.slug);
  const reviewed = conferenceFootballSources[canonical.slug];
  const canonicalSport = canonical.sports.find(value => value.slug === sport.slug);
  if (String(canonical.ncaaId) !== reviewed.ncaaId || canonicalSport.code !== sport.code
    || canonicalSport.conference.slug !== reviewed.conference) throw new Error('Conference football identity mismatch');
  return {
    url: reviewed.url,
    allowedHosts: [new URL(reviewed.url).hostname],
    collect: async fetch => reviewed.collect(await fetch(reviewed.url), reviewed.url, canonical, canonicalSport, fetch),
  };
}
