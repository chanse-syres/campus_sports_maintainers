import { assertCatalogScope } from '../providers.mjs';
import { collectSoconNews } from './socon-news.mjs';
import { collectNecNews } from './nec-news.mjs';

// Independent official conference publications replace university archives that
// deny public collector requests. Publisher attribution stays with the conference.
export const conferenceNewsSources = Object.freeze({
  'central-connecticut-state-university': Object.freeze({
    ncaaId: '127', conference: 'northeast', host: 'necsports.com',
    url: 'https://necsports.com/archives.aspx?path=football',
    blockedSourceUrl: 'https://www.ccsubluedevils.com/sports/fball/2026-27/news',
    reason: 'University archives deny collector requests with HTTP 405; use reviewed official NEC coverage.',
    sports: Object.freeze({ football: 'football', basketball: 'mbball', 'womens-basketball': 'wbball', baseball: 'baseball',
      'mens-cross-country': 'mcross', 'mens-soccer': 'msoc', 'mens-track-indoor': 'mitrack', 'mens-track-outdoor': 'mtrack',
      softball: 'softball', 'womens-cross-country': 'wcross', 'womens-lacrosse': 'wlax', 'womens-soccer': 'wsoc',
      'womens-swimming-and-diving': 'swim', 'womens-track-indoor': 'witrack', 'womens-track-outdoor': 'wtrack', 'womens-volleyball': 'wvball' }),
    collect: collectNecNews,
  }),
  'tennessee-technological-university': Object.freeze({
    ncaaId: '692', conference: 'southern', host: 'soconsports.com',
    url: 'https://soconsports.com/archives.aspx?path=football',
    blockedSourceUrl: 'https://www.ttusports.com/sports/fball/headlines-featured',
    reason: 'University archives deny collector requests with HTTP 405; use reviewed official SoCon coverage.',
    sports: Object.freeze({ football: 'football', basketball: 'mbball', 'womens-basketball': 'wbball', baseball: 'baseball',
      'mens-cross-country': 'mcross', 'mens-golf': 'mgolf', 'mens-tennis': 'mten', softball: 'sb',
      'womens-cross-country': 'wcross', 'womens-golf': 'wgolf', 'womens-soccer': 'wsoc',
      'womens-track-indoor': 'witrack', 'womens-track-outdoor': 'wtrack', 'womens-volleyball': 'vb' }),
    collect: collectSoconNews,
  }),
});

export function conferenceNewsSource(school, sport) {
  const reviewed = conferenceNewsSources[school.slug], path = reviewed?.sports[sport.slug];
  if (!path) return null;
  const canonical = assertCatalogScope(school, sport.slug);
  const canonicalSport = canonical.sports.find(value => value.slug === sport.slug);
  if (String(canonical.ncaaId) !== reviewed.ncaaId || canonicalSport.code !== sport.code
    || canonicalSport.conference.slug !== reviewed.conference) throw new Error('Conference news identity mismatch');
  const url = `https://${reviewed.host}/archives.aspx?path=${path}`;
  return {
    url, allowedHosts: [reviewed.host],
    collect: async fetch => reviewed.collect(await fetch(url), url, canonical, canonicalSport, fetch),
  };
}

// Established maintainSchool imports remain compatible while covering all
// reviewed sponsored sports rather than only football.
export const conferenceFootballSources = conferenceNewsSources;
export const conferenceFootballSource = conferenceNewsSource;
