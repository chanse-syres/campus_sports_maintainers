import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadPublicationBundle } from './publish.mjs';
const {values}=parseArgs({options:{output:{type:'string',default:'output'},conference:{type:'string'}}});
const conferences=values.conference?[values.conference]:await readdir(path.join(values.output,'v1','conferences'));
if(!conferences.length)throw new Error('No conference output');
for(const conference of conferences)await loadPublicationBundle(values.output,conference);
console.log(`Validated ${conferences.length} complete conference bundles.`);
