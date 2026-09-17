import { getSchool, getSport, loadCatalog, loadSources, COLLECTIONS } from './config.mjs';
import { fetchSourceText, SourceError } from './network.mjs';
import { emptyDataset, refreshDataset } from './dataset.mjs';
import { refreshNews } from './news.mjs';
import { resolveProvider } from './providers.mjs';
import { espnUrl, collectEspn } from './adapters/espn.mjs';
import { recruitingSourceUrl, collectRecruiting } from './adapters/recruiting.mjs';
import { collectOfficialNews, parseOfficialRoster, parseOfficialSchedule } from './adapters/official.mjs';
import { validateSnapshot } from './validate.mjs';
import { sourcePolicy } from './discovery.mjs';
import { webNewsSources } from './adapters/web-news.mjs';

export const recruitingCycle = date => date.getUTCFullYear() + (date.getUTCMonth() >= 2 ? 1 : 0);
const unavailable = (at, reason) => emptyDataset(at, 'unavailable', reason);
const conference = value => ({slug:value.slug,name:value.name});

/** One source request at a time per school; source errors remain dataset state. */
export async function maintainSchool(slug, { now = new Date().toISOString(), previous = null, sport: selectedSport, get, sources, requestBudget = 180, full = false, sharedCache = new Map() } = {}) {
  const school = await getSchool(typeof slug === 'string' ? slug : slug.slug);
  const catalog = await loadCatalog();
  if(previous) await validateSnapshot(previous, school.slug);
  const at = new Date(now).toISOString();
  const registry = sources ?? await loadSources();
  const official = registry.schools[school.slug];
  const officialPolicy=sourcePolicy(school);
  const officialSchool={...school,allowedHosts:officialPolicy.allowedHosts};
  const supplemental = new Map(school.sports.map(sport=>[sport.slug,webNewsSources(school,sport,at)]));
  const sharedUrls = new Set([...supplemental.values()].flat().map(s=>s.url));
  const allowedHosts = [...new Set([...officialPolicy.allowedHosts, 'site.api.espn.com', '247sports.com', 'www.247sports.com', ...[...supplemental.values()].flatMap(sources=>sources.flatMap(s=>s.allowedHosts))])];
  let requests = 0;
  const cache = new Map();
  const request = get ?? (url => fetchSourceText(url, {allowedHosts,maxBytes:8_000_000,timeoutMs:15_000}));
  const fetchSource = url => {
    const selectedCache=sharedUrls.has(url)?sharedCache:cache;
    if(!selectedCache.has(url)) selectedCache.set(url, Promise.resolve().then(() => {
      if(++requests > requestBudget) throw new SourceError('school-request-budget-exhausted');
      return request(url);
    }));
    return selectedCache.get(url);
  };
  const result = {schemaVersion:1,academicYear:catalog.academicYear,conference:conference(school.conference),school:{slug:school.slug,ncaaId:String(school.ncaaId),name:school.name,athleticsUrl:school.athleticsUrl,membershipSourceUrl:school.sourceUrl},generatedAt:at,sports:{}};
  const sports = selectedSport ? [getSport(school, selectedSport)] : school.sports;
  for(const sport of sports) {
    const source = official?.sports?.[sport.slug];
    const scopedSport = {...sport,routes:source?.routes ?? [],aliases:source?.aliases ?? []};
    const provider = resolveProvider(school,sport.slug);
    const prior = previous?.sports[sport.slug];
    const entry = {sponsored:true,code:sport.code,name:sport.name,gender:sport.gender,conference:conference(sport.conference)};
    const newsSources = [];
    if(source?.newsUrl) newsSources.push({url:source.newsUrl, collect:async fetch => collectOfficialNews(await fetch(source.newsUrl),source.newsUrl,officialSchool,scopedSport,fetch)});
    else if(school.athleticsUrl) newsSources.push({url:school.athleticsUrl,collect:async()=>{
      throw new SourceError(official?.status&&official.status!=='ok'?official.status:'official-sport-feed-not-discovered');
    }});
    if(provider.status === 'verified' && provider.news) {
      const url=espnUrl(school,sport.slug,'news',provider);sharedUrls.add(url);
      newsSources.push({url,collect:fetch=>collectEspn({school,sport:sport.slug,kind:'news',provider,observedAt:at,get:fetch})});
    }
    newsSources.push(...supplemental.get(sport.slug));
    entry.news = await refreshNews({school,sport,at,previous:prior?.news,sources:newsSources,get:fetchSource});
    if(!full) {
      for(const kind of COLLECTIONS.filter(k=>k!=='news')) entry[kind] = prior?.[kind]?.lastSuccessAt
        ? {...prior[kind],status:'stale',reason:'refresh-disabled-news-only'}
        : unavailable(at,'disabled-news-only');
      result.sports[sport.slug]=entry;
      continue;
    }
    for(const [kind,parse] of [['roster',parseOfficialRoster],['schedule',parseOfficialSchedule]]) {
      const url = source?.[`${kind}Url`];
      // Prefer the current official program page when discovered. A denial remains
      // visible rather than silently switching to an older provider roster.
      if(url) entry[kind] = await refreshDataset({at,sourceUrl:url,prior:prior?.[kind],get:fetchSource,parse:text=>parse(text,url,officialSchool,scopedSport)});
      else if(provider.status === 'verified') entry[kind] = await refreshDataset({at,sourceUrl:espnUrl(school,sport.slug,kind,provider),prior:prior?.[kind],collect:()=>collectEspn({school,sport:sport.slug,kind,provider,observedAt:at,get:fetchSource})});
      else entry[kind] = unavailable(at,'no-reviewed-program-source');
    }
    const officialHealth = entry.news.sources.find(s=>s.sourceUrl===source?.newsUrl);
    if(officialHealth) {
      const records = entry.news.records.filter(r=>r.discoverySourceUrl===source.newsUrl && /\b(signs?|signing|signees?|recruiting class|adds? .+ to (?:the )?roster|welcomes? .+ class)\b/i.test(r.title)).slice(0,400);
      const {recordCount,...health}=officialHealth;
      entry.recruitingAnnouncements = {...health,season:null,records,status:['ok','empty'].includes(health.status)?records.length?'ok':'empty':health.status,reason:['ok','empty'].includes(health.status)?'headline-classification-announcements-only':health.reason};
    } else entry.recruitingAnnouncements = unavailable(at,'no-reviewed-official-news-source');
    const recruiting = resolveProvider(school,sport.slug,'247sports');
    for(const [name,kind] of [['recruitingBoard','commits'],['recruitingOffers','offers']]) {
      if(recruiting.status === 'verified') {
        const year = recruitingCycle(new Date(at)), sourceUrl = recruitingSourceUrl(school,sport.slug,year,kind);
        entry[name] = await refreshDataset({at,sourceUrl,prior:prior?.[name],collect:()=>collectRecruiting({school,sport:sport.slug,year,observedAt:at,get:fetchSource,kind})});
      } else entry[name] = unavailable(at,'no-reviewed-recruiting-source');
      entry[name].records = entry[name].records.map(record=>({profileUrl:null,imageUrl:null,schoolName:null,hometown:null,rating:null,ratingSystem:null,stars:null,nationalRank:null,positionRank:null,stateRank:null,rankingState:null,rankingGroup:null,...record}));
    }
    result.sports[sport.slug]=entry;
  }
  return validateSnapshot(result,school.slug,{partial:Boolean(selectedSport)});
}

export function summarize(snapshot) {
  const counts = {school:snapshot.school.slug,programs:Object.keys(snapshot.sports).length,records:0,statuses:{},newsWithImages:0};
  for(const program of Object.values(snapshot.sports)) {
    const dataset=program.news; counts.statuses[dataset.status]=(counts.statuses[dataset.status]??0)+1; counts.records+=dataset.records.length;
    counts.newsWithImages+=dataset.records.filter(r=>r.imageUrl).length;
  }
  return counts;
}
