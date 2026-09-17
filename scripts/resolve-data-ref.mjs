import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitSha, githubRequest } from './publish.mjs';

// Called once in the read-only prepare job. Its short-lived token is never
// available in a collector, and only a public commit ID becomes a job output.
export async function resolveDataCommit({ request = githubRequest(process.env.GITHUB_TOKEN) } = {}) {
  const previous = await request('GET', 'git/ref/heads/data', undefined, true);
  return previous ? commitSha(previous.object?.sha) : 'absent';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolveDataCommit().then(commit => console.log(`commit=${commit}`)).catch(error => { console.error(`Data ref lookup failed: ${error.message}`); process.exitCode = 1; });
}
