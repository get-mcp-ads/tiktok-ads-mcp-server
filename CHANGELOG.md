# Changelog

## 2.1.1 - 2026-10-26 - Zod 4 security update
- Update `zod` to 4.6.7. Every Zod release before 4.6.6 is covered by the high-severity advisory GHSA-mrhx-c7xc-m3w5: validating an oversized constrained collection can exhaust memory, and no Zod 3 release carries the fix. `npm audit --omit=dev` reports no vulnerability again.
- Keep the Zod 3 validation behaviour. A parameter default is still validated and completed before use, so an omitted object must still supply its required fields.
- Keep each parameter's own description when the parameter is optional or has a default. Zod 4 stores a description on the wrapped schema only, so the shared fallback description could otherwise replace it.
- Tool names, parameters and descriptions published over MCP are unchanged. `server-card.json` is regenerated with Zod 4's JSON Schema output, which spells some constraints differently.

## 2.1.0 - 2026-10-23 - Advertiser scoping and account rename
- Add `tiktok_rename_advertiser`, which renames a Business Center ad account (advertiser) and changes nothing else. Previews by default.
- Add `TIKTOK_ADVERTISER_IDS`, an optional advertiser allowlist. When set, reads and writes outside it are refused before any request, account discovery responses are filtered to it, and a read must name an advertiser unless it targets a reference catalog. When unset, the server keeps the 2.0 behaviour and prints one stderr line recommending it.
- Send reads and writes to `sandbox-ads.tiktok.com` when `TIKTOK_ENVIRONMENT=sandbox`, bound to one sandbox advertiser, with OAuth and Business Center discovery refused there. Version 2.0.1 ignored this variable and sent every request to production.
- Keep reading `1`, `yes` and `on` in `TIKTOK_ENABLE_WRITES` as true, with one stderr deprecation line.
- Announced for 3.0.0: `TIKTOK_ADVERTISER_IDS` becomes required, and only the exact value `true` enables writes.
- Give every TikTok request a 30-second timeout and a 20 MB response limit, and redact the token and app secret from provider error text. Keep reading the `code` field of HTTP 200 answers as the outcome.
- Declare every API host in `src/core/hosts.ts`, with tests that fail on a fetch without redirect handling or timeout and on any other host in `src/`.
- Update `@modelcontextprotocol/sdk` to 1.32.1 and regenerate `package-lock.json`. Require Node.js 22.23.4, 24.22.1, 26.12.1 or newer, and warn on stderr at startup and in `npm run doctor` on an older release. CI covers Node 22, 24 and 26.
- Publish from a version tag with `release.yml`: npm with provenance, the GitHub release, then the MCP Registry. It replaces `publish-mcp.yml`. Dependabot now proposes weekly npm and monthly GitHub Actions updates.
- Remove an unused Google Ads request helper from the TikTok write module.

## 2.0.1 - 2026-09-23 - Public repository restored

- Restore public source hosting under the get-mcp-ads GitHub organization.
- Update repository and support links while preserving npm package and MCP registry names.
- No changes to platform tools or credential requirements.

## 2.0.0 - 2026-09-20 - Gateway sync and security fixes
- Preserve exact unquoted 64-bit IDs in read, write and verification responses.
- Fix campaign field selection and default list limits.
- Update native write validation for budgets, schedules, targeting and readback. Add carousel music, uploaded-video readiness, CTA portfolio and custom identity tools.
- Require Node.js 22.12 or newer and check Node 22/24 in CI.
- Update vulnerable dependencies and regenerate the MCP catalog.
- No hosted creative UI or MCP Apps integrations.


## 1.1.0 - 2026-09-13 - Platform capability sync and quality contracts
- Synchronize applicable platform features with GetMCPAds commit b1471be while retaining local read-only exploration tools and credential configuration.
- Expose 33 read tools and 27 explicitly enabled write tools.
- Add MCP annotations, parameter descriptions, structured results, server identity and an offline-generated discovery card.
- Preserve preview/confirmation boundaries; test provider request construction and errors with mocked APIs.
- Refuse credential-bearing redirects and document provider-specific limitations.

No live advertiser mutation is performed by the release tests.

## 1.0.2 - 2026-08-30

- Announce the package version over MCP. Version 1.0.1 still reported 1.0.0 in the handshake.

## 1.0.1 - 2026-08-30

- Add `server.json` and `mcpName` for the official MCP Registry, under `com.getmcpads/tiktok-ads`.
- Skip registry publication when a version is already listed.

## 1.0.0 - 2026-08-29 - First open-source release

- Publish the server as open source under the Apache-2.0 license.
