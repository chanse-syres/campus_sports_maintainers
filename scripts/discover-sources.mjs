import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { listSchools } from '../src/config.mjs';
import { fetchSourceText } from '../src/network.mjs';
import { discoverSchoolSources, enrichSportSources, officialHosts, discoverEntrance, sourcePolicy, discoverFromSitemap } from '../src/discovery.mjs';

export async function discover({ conference, schoolSlug, deep = false, resume = false } = {}) {
  const schools = (await listSchools(conference)).filter(s => !schoolSlug || s.slug === schoolSlug);
  if (!schools.length) throw new Error('No configured schools selected');
  const destination = new URL('../catalog/sources.json', import.meta.url);
  let catalog;
  try { catalog = JSON.parse(await readFile(destination, 'utf8')); } catch(error) { if(error.code !== 'ENOENT') throw error; catalog = { schemaVersion: 1, schools: {} }; }
  catalog.retrievedAt = new Date().toISOString();
  const queue = schools.filter(school => !resume || catalog.schools[school.slug]?.discoveryVersion !== 3);
  let saving = Promise.resolve();
  const checkpoint = () => {
    const snapshot = JSON.stringify({ ...catalog, schools: Object.fromEntries(Object.entries(catalog.schools).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n';
    saving = saving.then(async () => {
      const temporary = new URL('../catalog/sources.json.tmp', import.meta.url);
      await writeFile(temporary, snapshot);
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, destination); break; }
        catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 9) throw error; await setTimeout(50 * (attempt + 1)); }
      }
    });
    return saving;
  };
  await Promise.all(Array.from({length:4}, async () => {
    while(queue.length) {
      const school = queue.shift();
      try {
        if (!school.athleticsUrl) throw new Error('No official athletics URL');
        const policy = sourcePolicy(school);
        const options = {allowedHosts:policy.allowedHosts,maxBytes:8_000_000,timeoutMs:15_000};
        let html = await fetchSourceText(policy.athleticsUrl, options);
        const entrance = discoverEntrance(html, policy.athleticsUrl);
        if (entrance) html = await fetchSourceText(entrance, options);
        let result = discoverSchoolSources(html, school, entrance ?? policy.athleticsUrl);
        result.discoveryUrl = entrance ?? policy.athleticsUrl;
        if (!Object.values(result.sports).some(sport => sport.newsUrl)) {
          try {
            const sitemap = await discoverFromSitemap(school, url => fetchSourceText(url, options));
            if (sitemap) result = { ...discoverSchoolSources(sitemap.html, school, sitemap.sourceUrl), discoveryUrl: sitemap.sourceUrl };
          } catch (error) { result.sitemapStatus = error.code ?? 'source-discovery-failed'; }
        }
        if(deep) for(const sport of school.sports) {
          const source = result.sports[sport.slug];
          if(!source.homeUrl || (source.rosterUrl && source.scheduleUrl && source.newsUrl !== source.homeUrl)) continue;
          try { result.sports[sport.slug] = { ...enrichSportSources(await fetchSourceText(source.homeUrl,options),school,sport,source,result.allowedHosts), detailStatus: 'ok' }; }
          catch(error) { source.detailStatus = error.code ?? 'source-discovery-failed'; }
        }
        catalog.schools[school.slug] = { ...result, discoveryVersion: 3, retrievedAt: new Date().toISOString() };
        console.log(JSON.stringify({school:school.slug,status:'ok',sports:school.sports.length,discovered:Object.values(result.sports).filter(s=>s.homeUrl).length}));
      } catch(error) {
        catalog.schools[school.slug] = {athleticsUrl:school.athleticsUrl,allowedHosts:school.athleticsUrl?sourcePolicy(school).allowedHosts:[],status:error.code??'source-discovery-failed',discoveryVersion:3,retrievedAt:new Date().toISOString(),sports:{}};
        console.log(JSON.stringify({school:school.slug,status:catalog.schools[school.slug].status}));
      }
      await checkpoint();
    }
  }));
  catalog.schools = Object.fromEntries(Object.entries(catalog.schools).sort(([a],[b])=>a.localeCompare(b)));
  await checkpoint();
  return catalog;
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2), value=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  const known = new Set(['--conference', '--school', '--deep', '--resume']);
  for(let i=0;i<args.length;i++) { if(!known.has(args[i])) throw new Error('Unknown discovery argument'); if(['--conference','--school'].includes(args[i])) { if(!args[++i] || args[i].startsWith('--')) throw new Error('Missing discovery scope'); } }
  await discover({conference:value('--conference'),schoolSlug:value('--school'),deep:args.includes('--deep'),resume:args.includes('--resume')});
}
