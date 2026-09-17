import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generate } from './generate-hierarchy.mjs';
import { assertPublicValue, safeUrl } from '../src/normalize.mjs';
import { loadCatalog } from '../src/config.mjs';
import { sourcePolicy } from '../src/discovery.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
await import('./check-public-tree.mjs');
await generate({check:true});
const catalog=await loadCatalog();
for(const name of ['membership','sports','providers','sources','source-overrides','news-feeds','conferences','import-evidence']) {
  const value=await readFile(path.join(root,'catalog',`${name}.json`),'utf8');assertPublicValue(value);JSON.parse(value);
}
const sourceRegistry=JSON.parse(await readFile(path.join(root,'catalog','sources.json'),'utf8'));
for(const [slug,school] of Object.entries(sourceRegistry.schools)) {
  const canonical=catalog.schools.find(s=>s.slug===slug);if(!canonical)throw new Error('Unknown source school');
  const hosts=new Set(sourcePolicy(canonical).allowedHosts);
  if(school.allowedHosts.some(host=>!hosts.has(host)))throw new Error('Unreviewed discovered hostname');
  for(const [sport,source]of Object.entries(school.sports)) {
    if(!canonical.sports.some(p=>p.slug===sport))throw new Error('Unknown source sport');
    for(const [key,url]of Object.entries(source))if(key.endsWith('Url')&&url&&(!safeUrl(url)||!hosts.has(new URL(url).hostname)))throw new Error('Unreviewed source destination');
  }
}
for(const directory of ['src','scripts','examples','test']) {
  async function check(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {
    const filename=path.join(dir,entry.name);if(entry.isDirectory())await check(filename);
    else if(entry.name.endsWith('.mjs')){const result=spawnSync(process.execPath,['--check',filename],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);}
  }}await check(path.join(root,directory));
}
console.log('Catalog, generated hierarchy, public values, source destinations and JavaScript syntax checked.');
