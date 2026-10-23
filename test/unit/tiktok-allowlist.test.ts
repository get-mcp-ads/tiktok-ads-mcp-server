import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collect } from "./catalogue";
import { loadConfig } from "../../src/config";
import { TikTokClient } from "../../src/platforms/tiktok/client";

// Synthetic production fixtures. fetch is mocked; no TikTok account is reached.
const allowed = "7000000000000000001";
const other = "7000000000000000002";
const config = { accessToken: "fixture-token", appId: "fixture-app", appSecret: "fixture-secret", allowedAccountIds: [allowed] };
const fetcher = vi.fn();
const tiktok = (data: unknown, code = 0, message = "OK") => Response.json({ code, message, request_id: "req-fixture", data });
type Result = { isError?: boolean; content: { text: string }[] };
const invoke = (name: string, args: Record<string, unknown> = {}, settings: Record<string, unknown> = config) =>
  collect("tiktok_ads", settings).find(tool => tool.name === name)!.handler(args) as Promise<Result>;
const body = (result: Result) => JSON.parse(result.content[0].text);

beforeEach(() => { fetcher.mockReset().mockImplementation(async () => tiktok({ list: [] })); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("configuration", () => {
  const base = { TIKTOK_ACCESS_TOKEN: "fixture-token", TIKTOK_APP_ID: "fixture-app" };
  const load = (env: Record<string, string>) => {
    const notices: string[] = [];
    return { config: loadConfig({ ...base, ...env }, line => notices.push(line)), notices };
  };

  it("starts without an allowlist, as 2.0 did, and recommends one once", () => {
    const { config: loaded, notices } = load({});
    expect(loaded.allowedAccountIds).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/TIKTOK_ADVERTISER_IDS is not set.*required in 3\.0\.0/);
  });

  it("keeps TIKTOK_ADVERTISER_ID a default, never an allowlist, when the list is unset", () => {
    const { config: loaded } = load({ TIKTOK_ADVERTISER_ID: allowed });
    expect(loaded.allowedAccountIds).toBeUndefined();
    expect(loaded.defaultAdvertiserId).toBe(allowed);
    // 2.0 accepted any default advertiser spelling; so does 2.1.
    expect(load({ TIKTOK_ADVERTISER_ID: "legacy-default" }).config.defaultAdvertiserId).toBe("legacy-default");
  });

  it("reads a comma-separated allowlist, removes duplicates and prints no notice", () => {
    const { config: loaded, notices } = load({ TIKTOK_ADVERTISER_IDS: ` ${allowed}, ${other},${allowed} ` });
    expect(loaded.allowedAccountIds).toEqual([allowed, other]);
    expect(loaded.enableWrites).toBe(false);
    expect(loaded.tiktokEnvironment).toBe("production");
    expect(loaded.defaultAdvertiserId).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it.each([
    [{ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ADVERTISER_ID: other }, /TIKTOK_ADVERTISER_ID must be one of TIKTOK_ADVERTISER_IDS/],
    [{ TIKTOK_ADVERTISER_IDS: "act_123" }, /numeric advertiser IDs/],
    [{ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ENVIRONMENT: "staging" }, /TIKTOK_ENVIRONMENT must be production or sandbox/],
    [{ TIKTOK_ADVERTISER_IDS: `${allowed},${other}`, TIKTOK_ENVIRONMENT: "sandbox" }, /exactly one advertiser/],
    [{ TIKTOK_ACCESS_TOKEN: "", TIKTOK_ADVERTISER_IDS: allowed }, /TIKTOK_ACCESS_TOKEN is required/],
  ])("refuses %j at startup", (env, message) => {
    expect(() => load(env)).toThrow(message);
  });

  it("enables writes with the exact value true and prints no notice", () => {
    const enabled = load({ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ENABLE_WRITES: "true" });
    expect(enabled.config.enableWrites).toBe(true);
    expect(enabled.notices).toEqual([]);
    for (const value of ["false", "0", "off", ""]) expect(load({ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ENABLE_WRITES: value }).config.enableWrites).toBe(false);
  });

  it.each(["1", "yes", "on", "TRUE", " On "])("still reads the 2.0 spelling %j as true, with one deprecation notice", value => {
    const { config: loaded, notices } = load({ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ENABLE_WRITES: value });
    expect(loaded.enableWrites).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/from 3\.0\.0 only the exact value true enables writes/);
  });

  it("binds the sandbox to its single advertiser", () => {
    expect(load({ TIKTOK_ADVERTISER_IDS: allowed, TIKTOK_ENVIRONMENT: "sandbox" }).config).toMatchObject({ tiktokEnvironment: "sandbox", sandboxAdvertiserId: allowed, defaultAdvertiserId: allowed });
    expect(load({ TIKTOK_ADVERTISER_ID: allowed, TIKTOK_ENVIRONMENT: "sandbox" }).config).toMatchObject({ sandboxAdvertiserId: allowed, defaultAdvertiserId: allowed });
    const unbound = load({ TIKTOK_ENVIRONMENT: "sandbox" });
    expect(unbound.config.sandboxAdvertiserId).toBeUndefined();
    expect(unbound.notices.some(line => /sandbox calls are refused/.test(line))).toBe(true);
  });

  it("never echoes the access token in a configuration error or notice", () => {
    const notices: string[] = [];
    expect(() => loadConfig({ ...base, TIKTOK_ACCESS_TOKEN: "very-secret-token", TIKTOK_ENVIRONMENT: "staging", TIKTOK_ENABLE_WRITES: "on" }, line => notices.push(line))).toThrow(/^(?!.*very-secret-token)/);
    expect(notices.join("\n")).not.toContain("very-secret-token");
  });
});

describe("advertiser allowlist on reads", () => {
  it("refuses an advertiser outside the allowlist before any request", async () => {
    const result = await invoke("tiktok_get_campaigns", { advertiserId: other });
    expect(result.isError).toBe(true);
    expect(body(result).error).toContain("not in TIKTOK_ADVERTISER_IDS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the 2.0 behaviour when no allowlist is configured", async () => {
    const open = { accessToken: "fixture-token", appId: "fixture-app" };
    expect((await invoke("tiktok_get_campaigns", { advertiserId: other }, open)).isError).not.toBe(true);
    fetcher.mockImplementation(async () => tiktok({ list: [{ advertiser_id: allowed }, { advertiser_id: other }] }));
    const listed = body(await invoke("tiktok_list_advertisers", {}, open));
    expect(listed.data.list.map((row: { advertiser_id: string }) => row.advertiser_id)).toEqual([allowed, other]);
    expect((await invoke("tiktok_get_read_endpoint", { endpoint: "bc/advertiser/get", parameters: { bc_id: "42" } }, open)).isError).not.toBe(true);
  });

  it("refuses every request when the allowlist is set but empty", async () => {
    const result = await invoke("tiktok_get_campaigns", { advertiserId: allowed }, { accessToken: "fixture-token", allowedAccountIds: [] });
    expect(result.isError).toBe(true);
    expect(body(result).error).toContain("TIKTOK_ADVERTISER_IDS is empty");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a mixed advertiser_ids list as a whole", async () => {
    expect((await invoke("tiktok_get_advertiser_info", { advertiserIds: [allowed, other] })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("filters token-wide discovery to the allowlist", async () => {
    fetcher.mockImplementation(async () => tiktok({ list: [{ advertiser_id: allowed, advertiser_name: "Kept" }, { advertiser_id: other, advertiser_name: "Hidden" }] }));
    const listed = body(await invoke("tiktok_list_advertisers"));
    expect(listed.data.list.map((row: { advertiser_id: string }) => row.advertiser_id)).toEqual([allowed]);
    expect(JSON.stringify(listed)).not.toContain("Hidden");
    const health = body(await invoke("tiktok_health_check"));
    expect(health.checks.advertisers.advertisers.map((row: { advertiser_id: string }) => row.advertiser_id)).toEqual([allowed]);
    expect(health.credentials.allowedAdvertiserIds).toEqual([allowed]);
    expect(JSON.stringify(health)).not.toMatch(/fixture-token|fixture-secret/);
  });

  it("drops foreign advertisers from any list a generic read returns", async () => {
    fetcher.mockImplementation(async () => tiktok({ list: [{ advertiser_id: allowed }, { advertiser_id: other }] }));
    const result = body(await invoke("tiktok_get_read_endpoint", { endpoint: "bc/advertiser/get", parameters: { advertiser_id: allowed, bc_id: "42" } }));
    expect(result.data.data.list).toEqual([{ advertiser_id: allowed }]);
  });

  it("refuses a generic read that names no advertiser, except reference catalogs", async () => {
    expect((await invoke("tiktok_get_read_endpoint", { endpoint: "bc/advertiser/get", parameters: { bc_id: "42" } })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const catalog = await invoke("tiktok_get_targeting_catalog", { catalog: "timezones" });
    expect(catalog.isError).not.toBe(true);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/open_api/v1.3/tool/timezone/");
  });

  it("reports a TikTok error carried by an HTTP 200 answer", async () => {
    fetcher.mockImplementation(async () => tiktok(null, 40100, "Access token is invalid"));
    const result = await invoke("tiktok_get_campaigns", { advertiserId: allowed });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access token is invalid");
  });

  it("redacts the token and secret from provider error text", async () => {
    fetcher.mockImplementation(async () => tiktok(null, 40002, "bad token fixture-token for app secret fixture-secret"));
    const result = await invoke("tiktok_get_campaigns", { advertiserId: allowed });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/fixture-token|fixture-secret/);
    fetcher.mockImplementation(async () => new Response("upstream echoed fixture-token", { status: 502, statusText: "Bad Gateway" }));
    const http = await invoke("tiktok_get_campaigns", { advertiserId: allowed });
    expect(http.isError).toBe(true);
    expect(http.content[0].text).not.toContain("fixture-token");
  });

  it("sends every read with a timeout and without following redirects", async () => {
    await invoke("tiktok_get_campaigns", { advertiserId: allowed });
    const [, init] = fetcher.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    fetcher.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://example.com/?access_token=leak" } }));
    const result = await invoke("tiktok_get_campaigns", { advertiserId: allowed });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/example\.com|leak/);
  });

  it("refuses an oversized response instead of buffering it", async () => {
    fetcher.mockImplementation(async () => new Response("{}", { headers: { "content-length": String(50_000_000) } }));
    await expect(new TikTokClient("fixture-token", undefined, "v1.3", undefined, undefined, [allowed]).fetchUrl(`campaign/get/?advertiser_id=${allowed}`)).rejects.toThrow(/exceeds/);
  });
});

describe("advertiser allowlist on writes", () => {
  const writes = { ...config, enableWrites: true };

  it("keeps 2.0 write scoping when no allowlist is configured", async () => {
    const result = await invoke("tiktok_update_campaign_status", { advertiserId: other, campaignId: "200", status: "DISABLE" }, { accessToken: "fixture-token", enableWrites: true });
    expect(body(result)).toMatchObject({ applied: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses a foreign advertiser with confirm=%s before any request", async confirm => {
    const result = await invoke("tiktok_update_campaign_status", { advertiserId: other, campaignId: "200", status: "DISABLE", confirm }, writes);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not in TIKTOK_ADVERTISER_IDS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("previews an advertiser rename locally, then sends only the name", async () => {
    const preview = body(await invoke("tiktok_rename_advertiser", { advertiserId: allowed, name: "Renamed account" }, writes));
    expect(preview).toMatchObject({ applied: false, action: "tiktok_rename_advertiser", payload: { advertiser_id: allowed, advertiser_name: "Renamed account" } });
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/advertiser/info/")) return tiktok({ list: [{ advertiser_id: allowed, name: "Renamed account", currency: "USD" }] });
      return tiktok({});
    });
    const applied = body(await invoke("tiktok_rename_advertiser", { advertiserId: allowed, name: "Renamed account", confirm: true }, writes));
    expect(applied).toMatchObject({ applied: true, verification: { confirmed: true, name: "Renamed account" } });
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URL(String(posts[0][0])).pathname).toBe("/open_api/v1.3/advertiser/update/");
    expect(JSON.parse(posts[0][1].body)).toEqual({ advertiser_id: allowed, advertiser_name: "Renamed account" });
  });

  it("reports a rename TikTok refuses with HTTP 200 as not applied", async () => {
    fetcher.mockImplementation(async (input: string | URL) => new URL(String(input)).pathname.endsWith("/advertiser/info/")
      ? tiktok({ list: [{ advertiser_id: allowed, name: "Old", currency: "USD" }] })
      : tiktok(null, 40001, "Only Business Center admins can update this ad account"));
    const result = await invoke("tiktok_rename_advertiser", { advertiserId: allowed, name: "Renamed account", confirm: true }, writes);
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ outcome: "not_applied", retrySafe: false, code: 40001 });
  });
});
