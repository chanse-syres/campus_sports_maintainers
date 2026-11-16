import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const lanes = {
  'texas-news': { cron: '19 2,14 * * *', minute: 19, hours: [2, 14] },
  'osu-news': { cron: '37 11,17,23 * * *', minute: 37, hours: [11, 17, 23] },
  'osu-sports': { cron: '7 12 * * *', minute: 7, hours: [12] },
  'texas-sports': { cron: '43 12 * * *', minute: 43, hours: [12] },
};
const day = 86_400_000;
const slotLabel = time => new Date(time).toISOString().slice(0, 16) + 'Z';

function slotForRun(run, lane) {
  const created = Date.parse(run?.created_at);
  if (run?.head_branch !== 'main' || !Number.isFinite(created)) return null;
  const { cron, minute, hours } = lanes[lane];
  if (run.event === 'schedule' && run.display_title === `School schedule ${cron}`) {
    // GitHub supplies the cron expression, not the nominal occurrence date.
    // Anchor to run registration (stable through queue delays and reruns).
    const midnight = Math.floor(created / day) * day;
    const due = [midnight - day, midnight].flatMap(start =>
      hours.map(hour => start + (hour * 60 + minute) * 60_000));
    return slotLabel(Math.max(...due.filter(time => time <= created)));
  }
  const prefix = `School catch-up ${lane} `;
  if (run.event !== 'workflow_dispatch' || !run.display_title?.startsWith(prefix)) return null;
  const label = run.display_title.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(label)) return null;
  const time = Date.parse(label);
  if (!Number.isFinite(time) || time > created || slotLabel(time) !== label) return null;
  const date = new Date(time);
  return hours.includes(date.getUTCHours()) && minute === date.getUTCMinutes() ? label : null;
}

function confirmed(jobs) {
  return jobs.some(job => {
    if (job.name !== 'maintain' || job.status !== 'completed') return false;
    const stepPassed = name => job.steps?.some(step => step.name === name && step.conclusion === 'success');
    if (!stepPassed('Publish validated commits to the private app')) return false;
    // A legacy failure or a failed diagnostics-only publish is not a receipt.
    return job.conclusion === 'success' || stepPassed('Confirm public data push');
  });
}

export async function planSchoolPublication({ event, lane, scheduledSlot = '', id, attempt }, history) {
  if (!Object.hasOwn(lanes, lane)) throw new Error('Unrecognized school lane.');
  if (event === 'workflow_dispatch' && !scheduledSlot) return { eligible: true, slot: '' };
  if (!['schedule', 'workflow_dispatch'].includes(event) || !Number.isSafeInteger(id) || id < 1 ||
      !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid Actions run identity.');
  const current = await history.getRun(id);
  if (current.id !== id || current.event !== event) throw new Error('Actions run identity mismatch.');
  const slot = slotForRun(current, lane);
  if (!slot || (event === 'workflow_dispatch' && scheduledSlot !== slot)) {
    throw new Error('The run does not identify a valid scheduled slot for this lane.');
  }
  const prior = await history.listRuns(slot);
  if (!Array.isArray(prior)) throw new Error('Missing workflow run history.');
  const candidates = new Map([[id, current]]);
  for (const run of prior) {
    if (Number.isSafeInteger(run?.id) && run.id !== id && slotForRun(run, lane) === slot) {
      candidates.set(run.id, run);
    }
  }
  for (const run of candidates.values()) {
    // A successful previous attempt still counts if someone reruns that run.
    const last = run.id === id ? attempt - 1 : run.run_attempt;
    if (!Number.isSafeInteger(last) || last < 0) throw new Error('Invalid workflow run attempt history.');
    for (let number = last; number >= 1; number--) {
      const jobs = await history.listJobs(run.id, number);
      if (!Array.isArray(jobs)) throw new Error('Missing workflow job history.');
      if (confirmed(jobs)) return { eligible: false, slot, coveredBy: run.id };
    }
  }
  return { eligible: true, slot };
}

export function actionsHistory({ token, fetchImpl = fetch }) {
  const base = 'https://api.github.com/repos/chanse-syres/campus_sports_maintainers/actions';
  async function get(path) {
    if (!token) throw new Error('Actions history needs its read-only token.');
    const response = await fetchImpl(base + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Actions history is unavailable (HTTP ${response.status}).`);
    return response.json();
  }
  async function list(path, key) {
    const result = [];
    for (let page = 1; page <= 10; page++) {
      const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count)) {
        throw new Error('Malformed Actions history response.');
      }
      result.push(...data[key]);
      if (result.length >= data.total_count) return result;
      if (data[key].length !== 100) break;
    }
    throw new Error('Actions history is incomplete.');
  }
  return {
    getRun: id => get(`/runs/${id}`),
    listRuns: slot => {
      const start = new Date(slot).toISOString().replace('.000Z', 'Z');
      return list(`/workflows/school-maintenance.yml/runs?branch=main&created=${encodeURIComponent('>=' + start)}`, 'workflow_runs');
    },
    listJobs: (id, attempt) => list(`/runs/${id}/attempts/${attempt}/jobs`, 'jobs'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  try {
    const decision = await planSchoolPublication({
      event: env.GITHUB_EVENT_NAME, lane: env.SCHOOL_LANE, scheduledSlot: env.REQUESTED_SLOT,
      id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    }, actionsHistory({ token: env.SLOT_HISTORY_TOKEN }));
    await appendFile(env.GITHUB_OUTPUT, `eligible=${decision.eligible}\nslot=${decision.slot}\n`);
    const message = decision.coveredBy
      ? `Slot ${decision.slot} already covered by run ${decision.coveredBy}; no private publication.`
      : decision.slot ? `Slot ${decision.slot} eligible for publication.` : 'Manual refresh bypasses the slot check.';
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, message + '\n');
  } catch (error) {
    console.error(`School slot admission failed: ${error.message}`);
    process.exitCode = 1;
  }
}
