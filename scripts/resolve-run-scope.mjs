import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listConferences } from '../src/config.mjs';

export async function resolveRunScope({ eventName, requested = 'all' }) {
  assert.ok(['schedule', 'workflow_dispatch'].includes(eventName), 'Unsupported maintainer event');
  const all = (await listConferences()).map(conference => conference.slug);
  // Schedules never accept a partial scope, even if an input/environment value
  // is accidentally supplied. Only manual dispatch can choose one conference.
  if (eventName === 'schedule') return { conferences: all, conference: '' };
  assert.equal(typeof requested, 'string', 'Conference selector must be a string');
  if (requested === '' || requested === 'all') return { conferences: all, conference: '' };
  assert.ok(all.includes(requested), 'Unknown primary conference selector');
  return { conferences: [requested], conference: requested };
}

async function main() {
  const scope = await resolveRunScope({ eventName: process.env.GITHUB_EVENT_NAME, requested: process.env.MAINTAINER_CONFERENCE });
  // Only canonical catalog slugs reach the output file or summary. Raw input is
  // never interpolated into shell commands, workflow outputs, or Markdown.
  console.log(`conferences=${JSON.stringify(scope.conferences)}`);
  console.log(`conference=${scope.conference}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Collection scope: ${scope.conference || `all ${scope.conferences.length} primary conferences`}.\n\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Maintainer scope rejected: ${error.message}`); process.exitCode = 1; });
