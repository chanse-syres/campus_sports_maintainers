# News operations

The scheduled workflow runs every four hours. GitHub may delay scheduled jobs, so the site should continue displaying the last validated snapshot and its freshness indicator during a delay.

## First days of observation

Open **Actions → Maintain Division I news** and inspect the run summary. Check school coverage, article/photo counts, and stale/unavailable source rows. Review representative links for the intended school, sport, and gender. Some programs publish infrequently; an old article date alone is not a failed collector. A successful fetch alone is not a new article.

The publisher keeps all conferences in one data commit. A failed collection or validation prevents that national update; it does not delete the prior data branch. Inspect the failing conference job, repair the parser or reviewed source registry, and rerun the workflow. An access denial should remain visible; do not add proxies or session cookies to bypass it.

The site's server should cache the data commit lookup and decoded school data. Pin the manifest and school reads to that commit, verify checksums, and keep the last validated cache if a newer read fails. This prevents a temporary network problem from blanking the website.

## Local diagnostics

```sh
node src/cli.mjs --school arizona --sport womens-basketball --output output-preview
node src/cli.mjs --conference big-12 --output output
node scripts/publish.mjs --conference big-12 --output output --dry-run
node scripts/report-health.mjs --conference big-12 --output output --markdown
```

School/sport previews cannot be published as conference bundles. A lock prevents concurrent writers to an output tree. If a process is forcibly terminated, verify that no process is still writing before removing that output directory's `.maintainer.lock` file.

## Source and membership changes

Review the official NCAA membership import before accepting a new academic year or conference change. Review hostname overrides against a public university page or an observed official redirect. Rebuild the hierarchy, then run tests, checks, and a live collection. A schema or membership migration requires the workflow's explicit rebootstrap option; ordinary source failures must not trigger automatic discard of previous data.

Keep original article attribution and link destinations. Missing photos are represented as `null`; configure a site-owned fallback for those cards. Do not substitute unrelated athlete photos.

The private website is connected separately. No production database token, service-role key, or website deployment credential belongs in this public repository.
