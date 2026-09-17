# Connect the news sections

The national maintainer publishes normalized article metadata for NCAA Division I school/sport sections. The scheduled workflow runs every four hours. GitHub schedules can start late; use the timestamps and source health below instead of assuming a schedule guarantees freshness.

Only news collection is enabled by default. Roster, schedule, and recruiting envelopes may be present for compatibility but are not a readiness claim for those features. The maintainer does not republish complete articles. A card contains its headline, publisher, original article URL, publication date when known, and a source-provided photo URL when available.

## Builder handoff

1. Read `public-index.json` in the code branch to obtain every school slug, primary conference, and sponsored sport. After publication the same index is available as `v1/index.json` on the `data` branch. A school's folder follows its primary conference; individual sports retain their own conference membership.
2. Resolve the current `data` branch commit once per refresh, then request every related file at that exact commit. This prevents a manifest and school file from two different runs being combined. Cache the commit lookup server-side for at least five minutes and reuse that SHA across all school requests to avoid GitHub's anonymous API limit.
3. Read `v1/conferences/<conference>/manifest.json`. Find the school entry, fetch its `path` relative to that conference directory, and verify `bytes` and SHA-256 before using it.
4. Render `snapshot.sports[<sport>].news.records`. Use the provided `id` as the stable card key and `url` as the outbound link. Insert text through normal escaped framework components, never raw HTML. Use `rel="noopener noreferrer"` for links opened in another tab.
5. Keep your last valid snapshot if a download or integrity check fails. Display freshness using `generatedAt`, each news dataset's `lastSuccessAt`, and its `sources` health. Do not relabel preserved stale records as newly collected articles.

The executable Node 24 consumer in [`examples/read-school.mjs`](../examples/read-school.mjs) performs commit pinning, integrity checks, schema validation, school/conference checks, and freshness flags:

Map your existing site routes to this index using the NCAA school ID. Website slugs are not necessarily identical: Oregon State's catalog slug is `oregon-state-university`, for example. Men's basketball uses `basketball`; women's basketball uses `womens-basketball`. The index lists every supported key, so the builder should not construct school or sport names by guessing.

```sh
node examples/read-school.mjs arizona
```

Or import it in a server-side ingestion job from this repository:

```js
import { readPublishedSchool } from './examples/read-school.mjs';
const school = await readPublishedSchool('arizona');
const football = school.news.football;
// Persist validated metadata or render football.records in the football section.
```

For multiple schools, cache the returned `school.commit` centrally and pass `{ commit: cachedCommit }` to subsequent `readPublishedSchool` calls. Do not make one GitHub API lookup per page visit or per school. The Actions prepare job resolves the previous data SHA once using a step-scoped, read-only token; collector jobs receive only that public SHA and fetch immutable raw JSON without credentials.

No database, production website, or personal API credential belongs in this public repository. Your frontend/backend integration runs in your own application. The maintainer's publisher uses GitHub's short-lived workflow token exclusively in its separate publication step.

## Data locations

The public base URL is:

```text
https://raw.githubusercontent.com/chanse-syres/campus_sports_maintainers/<DATA_COMMIT_SHA>/
```

Replace `<DATA_COMMIT_SHA>` with the SHA from `GET https://api.github.com/repos/chanse-syres/campus_sports_maintainers/git/ref/heads/data`. The mutable `data` branch URL is convenient for inspecting a single file, but commit URLs are required when reading a manifest with its school files. These locations exist after the first successful publication; the code inventory alone does not mean live data has been published.

## Health and display behavior

| News status | Meaning | Frontend behavior |
| --- | --- | --- |
| `ok` | All configured sources succeeded and records are available. | Show cards; check freshness timestamps. |
| `empty` | Configured sources succeeded with a verified empty result. | Show an honest empty state. |
| `stale` | At least one source failed; available valid records are preserved. | Keep cards and expose a delayed-update indicator where appropriate. |
| `unavailable` | No successful data is available or no reviewed source is configured. | Show an unavailable/empty state; do not imply successful coverage. |

`sources` contains the per-source status and failure reason. A missing reviewed source differs from a temporarily blocked website. A green workflow confirms safe execution/publication; it does not mean all 7,080 sport sections have usable current news. Check workflow summaries and the health report during the initial observation period.

`imageUrl: null` means no reliable source photo was available. Use your school's approved fallback image or a text-only card. Never substitute an unrelated athlete image. An external image URL is attribution/provenance metadata, not a license grant; use publisher imagery according to your display rights. A blocked or broken image should fall back gracefully.

`publishedAtPrecision` is `instant`, `day`, or `unknown`. Avoid displaying a fabricated time for day-only dates; unknown publication dates remain `null`. The snapshot collection timestamp is not the article publication date.

## Operational checks

```sh
npm ci --ignore-scripts
npm test
npm run check
node src/cli.mjs --conference big-12 --output output
node scripts/publish.mjs --conference big-12 --output output --dry-run
node scripts/report-health.mjs --output output --conference big-12
```

For a full collection, use `--all` instead of `--conference`. For a single school or sport, use `--school <slug> [--sport <slug>]`; these are previews and cannot be published as a complete conference. Manual workflow runs default to validation-only unless `publish` is enabled. Scheduled runs publish automatically after every conference bundle validates. A failed conference collection prevents the national publication; the previously published data remains intact.

After a reviewed schema or academic-year/catalog migration, an operator may explicitly enable the manual workflow's `rebootstrap` input (default `false`). That choice is recorded in the run summary and skips all prior snapshots for that run; it does not bypass output validation or automatically publish. Existing data errors never trigger rebootstrap automatically. The first run with a genuinely absent data branch initializes normally.

Source outages retain prior data only from the same source and scope. Existing data download failures halt a workflow instead of silently replacing an unavailable previous snapshot. Every publication updates the `data` branch reference atomically and refuses to overwrite a concurrent writer or publish after the code branch advances.
