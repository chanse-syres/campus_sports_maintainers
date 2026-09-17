import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, listConferences } from '../src/config.mjs';
import { snapshotSchema } from '../src/schema.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function generate({check=false}={}) {
  const catalog=await loadCatalog(),conferences=await listConferences(),files=new Map();
  const json=(name,value)=>files.set(name,JSON.stringify(value,null,2)+'\n');
  const wrapper=(name,depth,args)=>files.set(name,`// Generated from the reviewed NCAA catalog. Run from any working directory.\nimport { run } from '${'../'.repeat(depth)}src/cli.mjs';\nawait run([...${JSON.stringify(args)}, ...process.argv.slice(2)]);\n`);
  for(const conference of conferences) {
    const base=`conferences/${conference.slug}`,schools=catalog.schools.filter(s=>s.conference.slug===conference.slug);
    json(`${base}/config.json`,{...conference,schools:schools.map(s=>s.slug)});
    wrapper(`${base}/maintainer.mjs`,2,['--conference',conference.slug]);
    for(const school of schools) {
      const directory=`${base}/${school.slug}`;
      json(`${directory}/config.json`,school);
      wrapper(`${directory}/maintainer.mjs`,3,['--school',school.slug]);
      for(const sport of school.sports)wrapper(`${directory}/sports/${sport.slug}/maintainer.mjs`,5,['--school',school.slug,'--sport',sport.slug]);
    }
  }
  json('public-index.json',{schemaVersion:1,academicYear:catalog.academicYear,membershipRetrievedAt:catalog.retrievedAt,sourceUrl:catalog.sourceUrl,conferences:conferences.map(c=>({slug:c.slug,name:c.name,manifestPath:`v1/conferences/${c.slug}/manifest.json`})),schools:catalog.schools.map(s=>({slug:s.slug,ncaaId:s.ncaaId,name:s.name,conference:s.conference.slug,path:`v1/conferences/${s.conference.slug}/schools/${s.slug}.json`,sports:s.sports.map(p=>({slug:p.slug,code:p.code,conference:p.conference.slug}))}))});
  const affiliates=new Map();
  for(const school of catalog.schools)for(const sport of school.sports){const key=sport.conference.slug;if(!affiliates.has(key))affiliates.set(key,{...sport.conference,programs:[]});affiliates.get(key).programs.push({school:school.slug,sport:sport.slug,primaryConference:school.conference.slug});}
  json('catalog/conferences.json',{schemaVersion:1,academicYear:catalog.academicYear,primary:conferences,affiliations:[...affiliates.values()].sort((a,b)=>a.slug.localeCompare(b.slug))});
  json('schemas/snapshot.schema.json',snapshotSchema);
  for(const [name,content]of files) {
    const target=path.join(root,name);
    if(check){if(await readFile(target,'utf8')!==content)throw new Error(`Generated file differs: ${name}`);}
    else {await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
  }
  return {files:files.size,schools:catalog.schools.length,programs:catalog.schools.reduce((n,s)=>n+s.sports.length,0),conferences:conferences.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await generate({check:process.argv.includes('--check')})));
