# Football maintenance

Every NCAA Division I football program in the reviewed membership catalog uses the shared news collector and the existing four-hour national schedule. A new cataloged football program participates automatically; a frontend route still needs an explicit NCAA identity mapping. Conference folders use primary membership while each sport retains its own affiliation.

Oregon State and Texas provide the operational reference: exact school and sport identity, source-backed facts and dates, isolated ownership, retained last-good records, and separate checks for collection, publication, and live rendering. This public workflow publishes news metadata. It does not claim that every school has roster, staff, schedule, transfer, or recruiting automation equivalent to their private football workspaces. The experimental `--full` adapters remain outside this release's readiness claim.

## Automated health check

After validated data is published, `scripts/report-football-health.mjs` examines every expected football snapshot in that run's scope. **Maintain Division I news** saves the report and prints source warnings. A separate **Check football news sources** workflow enforces that exact report: a missing snapshot, degraded news or source state, missing successful observation, or source/snapshot observation older than 12 hours fails the health workflow. A future observation time outside a five-minute clock tolerance also fails.

The check deliberately follows publication: an inaccessible source must not stop healthy colleges' validated updates. A green maintenance run confirms publication; a red source-health run means coverage needs attention. Source failures retain the previous source-backed data and its actual successful observation date. This separation does not repair or suppress publisher access denials.

The health workflow accepts only successful main-branch maintenance runs from this repository, verifies that the publication job succeeded, and downloads the exact originating run's report with a read-only token. Validation-only manual runs are skipped. Missing or malformed reports fail; neither workflow uses `continue-on-error` to hide report failures.

The job summary lists affected schools, source problems, article counts, and separate observation/publication dates. The `football-maintenance-health` artifact retains the complete JSON report for 14 days, including successful programs. It contains public source metadata only. No website database credential or private application configuration is introduced.

Empty verified feeds and publication dates older than 14 days prompt content review. They do not, by themselves, fail collection: a publisher may simply have no newer stories. Never relabel a successful crawl as a new article date.

```sh
node scripts/report-football-health.mjs --output output --markdown
node scripts/report-football-health.mjs --output output --conference southeastern --write-report --enforce
```

The JSON report is written to `output/football-health.json`. Without `--enforce`, the command is informational. `--enforce` returns a nonzero exit status for failed source health or incomplete scope. A conference without a sponsored football program has no expected football snapshots and passes with zero programs.

## Repair and rollout

1. Inspect the failed school's exact source and compare its current official navigation. Distinguish denied access, changed page formats, removed feeds, and old publisher content.
2. Add a focused regression and review a source/parser correction. Preserve school identity, sport routing, host restrictions, and previous evidence.
3. Pass repository tests, checks, and output validation. Source changes follow the repository's normal protected-branch review; do not bypass review to make a status green.
4. Run the existing maintainer workflow for the affected primary conference with publication enabled and `rebootstrap=false`. Verify its publication and the football health artifact independently.
5. Check the site's corresponding football section against the newly published immutable data commit. A successful collector alone does not prove the frontend is connected.

Football health enforcement covers the selected publication scope. A healthy conference repair is not a national all-clear; use the next full scheduled report for that claim.
