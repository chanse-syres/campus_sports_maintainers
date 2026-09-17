# Security policy

## Trust boundaries

The public repository contains collector code, reviewed public source configurations, public membership data, and headline metadata. It does not contain the private website, database credentials, API keys, cookies, or account sessions. Keep site-side ingestion server-side when it requires credentials; never add those credentials to this repository.

Collectors use fixed reviewed HTTPS hosts. They reject URL credentials, signed access grants, literal IP destinations, private DNS answers, unsafe redirects, oversized responses, and unexpected content types. DNS is checked and pinned for each request. Remote pages are parsed as data and are never executed. Access denials and rate limits are reported, not bypassed. Transient network/server errors receive at most one retry.

Publication accepts only complete conference bundles with exact catalog identities, closed JSON schemas, expected paths, checksums, bounded sizes, and consistent generation times. It rejects symlinks and hardlinks. Updates to the data branch are atomic and non-forced. Source collection receives no write token; the trusted publication job receives only the repository permissions needed to update public data. Third-party Actions are pinned to commit hashes.

## Operating rules

- Never commit `.env` files, authentication headers, raw private responses, or local account paths.
- Review membership/source registry changes, workflow changes, parser changes, and dependency updates before merging.
- Run tests, generated-file checks, dependency audit, and publication dry-run before release.
- Do not use `pull_request_target` to execute contributor code, unpinned Actions, self-hosted runners for public PRs, or site/database secrets in collector jobs.
- Treat all published strings and URLs as untrusted input in the consumer. Render text without raw HTML. Use an approved image delivery policy and retain a fallback for missing or disallowed images.
- Inspect stale/unavailable source states and article dates separately from workflow success. A parser change can affect routing without causing a network error.

## Reporting a vulnerability

Use this repository's private GitHub security advisory reporting when enabled. Do not disclose credentials, exploit payloads containing private data, or private site details in a public issue. If a credential is exposed, revoke it promptly; removing a file does not remove earlier Git history.

Automated scans and tests reduce risk but do not guarantee that code or upstream providers are vulnerability-free.
