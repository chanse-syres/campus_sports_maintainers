import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { getSchool, getSport, listSchools, listConferences, loadCatalog } from './config.mjs';
import { maintainSchool, summarize } from './maintainer.mjs';

export async function atomicJson(destination, value) {
  await mkdir(path.dirname(destination),{recursive:true});
  const bytes=JSON.stringify(value,null,2)+'\n', temp=`${destination}.${process.pid}.tmp`;
  await writeFile(temp,bytes,{flag:'wx'});
  await rename(temp,destination);
  return Buffer.from(bytes);
}

export async function run(args=process.argv.slice(2), {maintain=maintainSchool,log=console.log}={}) {
  const {values} = parseArgs({args,strict:true,allowPositionals:false,options:{all:{type:'boolean'},conference:{type:'string'},school:{type:'string'},sport:{type:'string'},previous:{type:'string'},output:{type:'string',default:'output'},full:{type:'boolean',default:false},help:{type:'boolean'}}});
  if(values.help){log('node src/cli.mjs --all | --conference SLUG | --school SLUG [--sport SLUG] [--previous previous] [--output output]');return;}
  if([values.all,values.conference,values.school].filter(Boolean).length!==1)throw new Error('Choose exactly one of --all, --conference, or --school');
  if(values.sport&&!values.school)throw new Error('--sport requires --school');
  const selected=values.school?await getSchool(values.school):null;
  if(selected&&values.sport)getSport(selected,values.sport);
  const conferences=values.all?await listConferences():selected?[selected.conference]:(await listSchools(values.conference)).slice(0,1).map(s=>s.conference);
  const root=path.resolve(values.output),catalog=await loadCatalog();
  await mkdir(root,{recursive:true});
  // One lock for the output tree prevents a school preview and a conference run
  // from writing concurrently. It contains no source responses or credentials.
  const lock=path.join(root,'.maintainer.lock');
  const handle=await open(lock,'wx');
  try {
    const conferenceQueue=[...conferences];
    const conferenceWorkers=await Promise.allSettled(Array.from({length:Math.min(4,conferences.length)},async()=>{
     while(conferenceQueue.length) {
      const conference=conferenceQueue.shift();
      const generatedAt=new Date().toISOString();
      const schools=selected?[selected]:await listSchools(conference.slug),queue=[...schools],entries=[],sharedCache=new Map();
      const workers=await Promise.allSettled(Array.from({length:Math.min(2,schools.length)},async()=>{
        while(queue.length) {
          const school=queue.shift();let previous=null;
          if(values.previous) {
            const filename=path.join(path.resolve(values.previous),'v1','conferences',conference.slug,'schools',`${school.slug}.json`);
            try { previous=JSON.parse(await readFile(filename,'utf8')); } catch(error){if(error.code!=='ENOENT')throw error;}
          }
          const snapshot=await maintain(school.slug,{now:generatedAt,previous,sport:values.sport,full:values.full,sharedCache});
          const relative=selected?path.join('preview',school.slug,`${values.sport??'all-sports'}.json`):path.join('v1','conferences',conference.slug,'schools',`${school.slug}.json`);
          const bytes=await atomicJson(path.join(root,relative),snapshot);
          entries.push({slug:school.slug,path:`schools/${school.slug}.json`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
          log(JSON.stringify(summarize(snapshot)));
        }
      }));
      const failed=workers.find(worker=>worker.status==='rejected');
      if(failed)throw failed.reason;
      if(!selected)await atomicJson(path.join(root,'v1','conferences',conference.slug,'manifest.json'),{schemaVersion:1,academicYear:catalog.academicYear,conference:{slug:conference.slug,name:conference.name},generatedAt,schools:entries.sort((a,b)=>a.slug.localeCompare(b.slug))});
     }
    }));
    const conferenceFailure=conferenceWorkers.find(worker=>worker.status==='rejected');
    if(conferenceFailure)throw conferenceFailure.reason;
  } finally {await handle.close();await rm(lock,{force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch(error=>{console.error(error.message);process.exitCode=1;});
}
