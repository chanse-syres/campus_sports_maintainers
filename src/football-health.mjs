const HOUR = 3_600_000;
export const FOOTBALL_OBSERVATION_MAX_AGE_HOURS = 12;
export const FOOTBALL_ARTICLE_REVIEW_AGE_DAYS = 14;

function ageHours(value, now) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? (now - at) / HOUR : null;
}

/** Source observation health is independent of how often a publisher posts. */
export function footballHealth(snapshots, { expectedSchools, now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error('A valid observation time is required');
  if (!Array.isArray(expectedSchools) || new Set(expectedSchools).size !== expectedSchools.length) {
    throw new Error('An explicit unique football school inventory is required');
  }
  const expected = new Set(expectedSchools), seen = new Set(), programs = [], errors = [];
  for (const snapshot of snapshots) {
    const school = snapshot.school?.slug;
    if (!expected.has(school) || seen.has(school)) {
      errors.push(`${school ?? 'unknown'}: unexpected or duplicate football snapshot`);
      continue;
    }
    seen.add(school);
    const news = snapshot.sports?.football?.news, issues = [], warnings = [];
    if (!news || !Array.isArray(news.records) || !Array.isArray(news.sources)) {
      errors.push(`${school}: football news dataset is missing`);
      continue;
    }
    const observationAgeHours = ageHours(news.lastSuccessAt, now);
    const snapshotAgeHours = ageHours(snapshot.generatedAt, now);
    if (!['ok', 'empty'].includes(news.status)) issues.push(`news status: ${news.status}`);
    if (observationAgeHours === null) issues.push('no successful news observation');
    else if (observationAgeHours < -5 / 60) issues.push('news observation is in the future');
    else if (observationAgeHours > FOOTBALL_OBSERVATION_MAX_AGE_HOURS) issues.push('news observation is overdue');
    if (snapshotAgeHours === null || snapshotAgeHours < -5 / 60) issues.push('invalid snapshot observation time');
    else if (snapshotAgeHours > FOOTBALL_OBSERVATION_MAX_AGE_HOURS) issues.push('snapshot is overdue');
    if (!news.sources.length) issues.push('no configured news source observations');
    const sources = news.sources.map(source => {
      const age = ageHours(source.lastSuccessAt, now);
      const healthy = ['ok', 'empty'].includes(source.status) && age !== null && age >= -5 / 60 && age <= FOOTBALL_OBSERVATION_MAX_AGE_HOURS;
      if (!healthy) issues.push(`source ${source.sourceUrl}: ${source.reason || source.status || 'missing observation'}`);
      return { url: source.sourceUrl, status: source.status, reason: source.reason ?? null, lastSuccessAt: source.lastSuccessAt ?? null, healthy };
    });
    const dates = news.records.map(record => record.publishedAt).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b));
    const lastArticleAt = dates.at(-1) ?? null;
    if (!news.records.length) warnings.push('no published articles');
    else if (!lastArticleAt) warnings.push('article publication dates are unknown');
    else if (ageHours(lastArticleAt, now) > FOOTBALL_ARTICLE_REVIEW_AGE_DAYS * 24) warnings.push('publisher content age needs review; successful collection does not establish new content');
    const row = { school, conference: snapshot.conference.slug, status: news.status, articles: news.records.length,
      photos: news.records.filter(record => record.imageUrl).length, generatedAt: snapshot.generatedAt,
      lastSuccessAt: news.lastSuccessAt ?? null, observationAgeHours, lastArticleAt, sources, issues, warnings, passed: issues.length === 0 };
    programs.push(row);
    errors.push(...issues.map(issue => `${school}: ${issue}`));
  }
  for (const school of expected) if (!seen.has(school)) errors.push(`${school}: football snapshot is missing`);
  programs.sort((a, b) => a.school.localeCompare(b.school));
  return { schemaVersion: 1, observedAt: new Date(now).toISOString(), passed: errors.length === 0,
    expectedPrograms: expected.size, checkedPrograms: programs.length,
    healthyPrograms: programs.filter(program => program.passed).length,
    programsNeedingSourceRepair: expected.size - programs.filter(program => program.passed).length,
    programsNeedingContentReview: programs.filter(program => program.warnings.length).length,
    observationMaxAgeHours: FOOTBALL_OBSERVATION_MAX_AGE_HOURS,
    articleReviewAgeDays: FOOTBALL_ARTICLE_REVIEW_AGE_DAYS, errors, programs };
}

const cell = value => String(value ?? 'unavailable').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ');

export function footballHealthMarkdown(report) {
  const attention = report.programs.filter(program => program.issues.length || program.warnings.length);
  return ['## Football maintenance health', '',
    `${report.healthyPrograms}/${report.expectedPrograms} football programs have current successful source observations. ${report.programsNeedingSourceRepair} need source repair; ${report.programsNeedingContentReview} need content review.`, '',
    'This check runs after publication. Valid snapshots remain available even when a source is blocked. Article publication dates are never advanced by a successful collection.', '',
    '| School | Source health | Articles | Last source success | Latest article | Action |',
    '|---|---|---:|---|---|---|',
    ...attention.map(program => `| ${cell(program.school)} | ${program.passed ? 'current' : 'needs repair'} | ${program.articles} | ${cell(program.lastSuccessAt)} | ${cell(program.lastArticleAt)} | ${cell([...program.issues, ...program.warnings].join('; '))} |`),
    ...(attention.length ? [] : ['| All checked football programs | current | | | | No source failures or content-age warnings. |']), '',
    ...report.errors.filter(error => /snapshot is missing|unexpected or duplicate|dataset is missing/.test(error)).map(error => `- ${cell(error)}`),
    '', `Source observations older than ${report.observationMaxAgeHours} hours fail this check. Article age over ${report.articleReviewAgeDays} days prompts review without mislabeling the publisher as a collection failure.`, ''].join('\n');
}
