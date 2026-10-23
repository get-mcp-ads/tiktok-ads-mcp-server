# Source synchronization

Reviewed on 2026-10-23 against getmcpads source revision `3e1c2c8`. The previous review used revision `41cc1ca`.

## Synchronized

- `958ba80` (2026-10-21), dedicated rename tools: adds `tiktok_rename_advertiser`, which sends only `advertiser_name` to `advertiser/update/` and reads the advertiser back. TikTok accepts it only for ad accounts created in a Business Center, renamed by a Business Center admin.
- `dbe5170` (2026-10-20), bind read clients to the sandbox environment: reads now use the same environment as writes. In sandbox, every read must name the bound advertiser, OAuth and Business Center discovery are refused, account listing uses `advertiser/info/`, and no request falls back to production. The ported gateway test runs as `test/unit/tiktok-sandbox-read-routing.test.ts`.

## Adapted for the standalone server

- The gateway checks hosted account selection before a tool runs. Here the optional `TIKTOK_ADVERTISER_IDS` plays that role: when set, the read client and the write transport refuse any other advertiser before a request, and responses that list advertisers are filtered to it. It becomes required in 3.0.0; 2.x keeps 2.0 setups working.
- The gateway binds the sandbox through `TIKTOK_SANDBOX_ADVERTISER_ID`. Here sandbox mode takes the single ID in `TIKTOK_ADVERTISER_IDS`, or `TIKTOK_ADVERTISER_ID` when the list is unset.
- The configuration field `environment` became `tiktokEnvironment`, the name the write transport already read. Version 2.0.1 never passed the variable to either client, so every request went to production.

## Not synchronized

- `989fb92` (2026-10-02) and `ed9445c` (2026-10-03) add parent IDs and running states to report rows for the hosted cockpit drill-down. They serve the hosted interface and are left out.

The public server remains self-contained. Hosted billing, quotas and plans, workspaces, stored account selection, token storage, creative galleries, the Launcher, alerts, Google Sheets exports, client memory, telemetry, MCP Apps UI and the discovery meta-tools (`get_capabilities`, `describe_tool`, `run_tool`) stay hosted-only. Existing standalone protections and public features newer than the hosted source are retained.

Validation uses synthetic data. No live advertising write is required by the test suite. The generated server-card.json is the source of truth for this revision's tool schemas.

Maintainer: Emmanuel, getmcpads. Contact: hello@getmcpads.com.
