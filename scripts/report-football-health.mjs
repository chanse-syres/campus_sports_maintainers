import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listSchools } from '../src/config.mjs';
import { validateSnapshot } from '../src/validate.mjs';
import { parsePublicJson } from '../src/manifest.mjs';
import { footballHealth, footballHealthMarkdown } from '../src/football-health.mjs';

export async function reportFootballHealth({ output = 'output', conference, now = Date.now() } = {}) {
  const schools = (await listSchools(conference)).filter(school => school.sports.some(sport => sport.slug === 'football'));
  const snapshots = [];
  for (const school of schools) {
    const filename = path.join(path.resolve(output), 'v1', 'conferences', school.conference.slug, 'schools', `${school.slug}.json`);
    try { snapshots.push(await validateSnapshot(parsePublicJson(await readFile(filename)), school.slug)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...footballHealth(snapshots, { expectedSchools: schools.map(school => school.slug), now }), scope: conference ?? 'all' };
}

export async function run(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    output: { type: 'string', default: 'output' }, conference: { type: 'string' }, markdown: { type: 'boolean' },
    enforce: { type: 'boolean' }, 'write-report': { type: 'boolean' },
  } });
  const result = await reportFootballHealth(values);
  if (values['write-report']) {
    await mkdir(path.resolve(values.output), { recursive: true });
    await writeFile(path.join(path.resolve(values.output), 'football-health.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(values.markdown ? footballHealthMarkdown(result) : JSON.stringify(result, null, 2));
  return values.enforce && !result.passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
