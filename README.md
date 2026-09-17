# Campus Sports Maintainers

Public news maintainers organized by NCAA Division I conference, school, and sponsored sport. The initial release prioritizes **news automation**. Scheduled runs do not refresh rosters, schedules, or recruiting boards.

The reviewed NCAA 2026–27 catalog contains **365 schools, 7,080 school-sport programs, and 32 primary conferences**, including four schools transitioning into Division I. Sport-specific conference affiliations are retained separately, so affiliate teams do not inherit the wrong conference. The catalog records NCAA-reported sponsorship; it is not a promise that every school's unreported varsity activity appears in the NCAA directory.

## Layout

```text
conferences/<conference>/<school>/maintainer.mjs
conferences/<conference>/<school>/sports/<sport>/maintainer.mjs
catalog/                 Reviewed membership and source registries
src/                     Shared collection, routing, and validation
schemas/                 Published JSON contract
examples/                Frontend/backend consumer
```

Each school entry point runs all of that school's registered sports. Small sport entry points use the same maintained engine; fixes apply across the entire catalog. `catalog/conferences.json` also indexes sport-specific conference affiliations.

## Run

Use Node.js 24, then install the exact lockfile dependencies:

```sh
npm ci --ignore-scripts
npm test
npm run check
node src/cli.mjs --conference big-12
node src/cli.mjs --school arizona --sport football
node conferences/big-12/arizona/maintainer.mjs
```

Conference runs produce complete publishable bundles under `output/v1/conferences/`. School and sport runs produce isolated previews under `output/preview/`; a preview cannot replace a complete conference. `--previous previous` preserves last successful data after a source failure. `--full` opts into additional experimental provider adapters; these are outside the news release's readiness claim.

## News behavior

- Collect headline metadata, original links, publication dates, publisher names, and publisher-provided photo URLs from reviewed official and independent feeds.
- Route by canonical school identity, sport, and gender. Ambiguous stories stay out of sections that cannot be verified.
- Deduplicate article links and matching headline/day combinations, retaining up to 1,000 article records per program.
- Keep previous records on blocked or broken sources and report their stale status. Never convert an access denial into an empty success.
- Publish plain JSON metadata. Article bodies, cookies, credentials, and private backend information are excluded.

This is a bounded source registry, not an exhaustive crawl of the internet. A missing photograph remains `null`; the site should provide its own fallback. `lastSuccessAt` means a feed was successfully observed, not that the publisher posted something new. Article dates and source health must be considered separately.

## Connect the site

See [the integration guide](docs/INTEGRATION.md). The data branch exposes `v1/index.json`, conference manifests, and individual school snapshots. Read a manifest and its snapshots at the same immutable commit, verify checksums, and render `sports[slug].news.records`. Preserve source attribution and outbound links.

```sh
node scripts/report-health.mjs --output output --conference big-12 --markdown
```

The Actions run summary reports article and photo counts, empty schools/programs, and source failures. A successful publication confirms validated output, not complete news coverage. During the initial observation period, review these counts and individual source failures after each run.

## Updating membership and sources

`scripts/catalog/import-ncaa.mjs` imports official NCAA membership and sport sponsorship. `scripts/discover-sources.mjs` reads observed official navigation. Provider imports and source discovery are maintenance commands, not automatic trust expansion during news runs. Review changes before regenerating the hierarchy with `node scripts/generate-hierarchy.mjs` and running all checks.

## Security

See [SECURITY.md](SECURITY.md). The collector has no site database credentials and cannot write to the site. Publication is limited to validated public data in this repository. Code and dependency changes require review; public visibility does not make any system immune to compromise.

Code is licensed under MIT. Third-party article metadata, photos, names, and marks remain subject to their respective owners' terms; this repository does not grant rights to those materials.
