import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collect } from "./catalogue";
import { TikTokClient, assertSafeTikTokApiUrl } from "../../src/platforms/tiktok/client";

// Ported from the getmcpads gateway (dbe5170). Every provider response below is
// synthetic. No live credentials or API calls.
const id = "7686435597921255442";
const config = { accessToken: "fixture-token", appId: "fixture-app", appSecret: "fixture-secret", tiktokEnvironment: "sandbox", sandboxAdvertiserId: id, allowedAccountIds: [id] } as const;
const row = { advertiser_id: id, advertiser_name: "Sandbox fixture", currency: "EUR", timezone: "Etc/GMT-1" };
const fetcher = vi.fn();
const response = (data: unknown = { list: [row] }) => Response.json({ code: 0, message: "OK", data });
const client = (scope: Record<string, unknown> = config) => new TikTokClient("fixture-token", undefined, "v1.3", "fixture-app", "fixture-secret", [id], scope);
const invoke = (name: string, args: Record<string, unknown> = {}, settings: Record<string, unknown> = config) => collect("tiktok_ads", settings).find(tool => tool.name === name)!.handler(args) as Promise<{ isError?: boolean; content: { text: string }[] }>;

beforeEach(() => { fetcher.mockReset().mockImplementation(async () => response()); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.unstubAllGlobals(); });

function sandboxCalls(count: number) {
  expect(fetcher).toHaveBeenCalledTimes(count);
  for (const [input, init] of fetcher.mock.calls) {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://sandbox-ads.tiktok.com");
    expect(url.pathname).toMatch(/^\/open_api\/v1\.3\//);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { "Access-Token": "fixture-token" } });
    expect(url.toString()).not.toMatch(/fixture-token|fixture-secret|access_token|secret=/);
    expect(url.searchParams.get("advertiser_id") ?? JSON.parse(url.searchParams.get("advertiser_ids")!)[0]).toBe(id);
  }
}

describe("TikTok sandbox read routing", () => {
  it.each([
    ["tiktok_get_advertiser_info", { advertiserIds: [id] }, "advertiser/info/"],
    ["tiktok_get_campaigns", { advertiserId: id }, "campaign/get/"],
    ["tiktok_list_ad_images", { advertiserId: id, page: 2 }, "file/image/ad/search/"],
    ["tiktok_list_ad_videos", { advertiserId: id }, "file/video/ad/search/"],
    ["tiktok_get_asset_urls", { advertiserId: id, imageIds: ["fixture-image"] }, "file/image/ad/info/"],
    ["tiktok_get_read_endpoint", { endpoint: "identity/get", parameters: { advertiser_id: id } }, "identity/get/"],
  ])("routes %s to the configured sandbox and exact advertiser", async (name, args, path) => {
    const result = await invoke(name as string, args as Record<string, unknown>);
    expect(result.isError).not.toBe(true);
    sandboxCalls(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(`/open_api/v1.3/${path}`);
  });

  it.each(["tiktok_list_advertisers", "tiktok_health_check"])("bounds %s without an advertiser argument to advertiser/info, never OAuth discovery", async name => {
    fetcher.mockImplementation(async () => response({ list: [row, { ...row, advertiser_id: "999" }] }));
    const result = await invoke(name);
    expect(result.isError).not.toBe(true);
    sandboxCalls(name === "tiktok_health_check" ? 2 : 1);
    expect(fetcher.mock.calls.every(([input]) => new URL(String(input)).pathname.endsWith("/advertiser/info/"))).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    const listed = name === "tiktok_health_check" ? payload.checks.advertisers.advertisers : payload.data.list;
    expect(listed.map((account: { advertiser_id: string }) => account.advertiser_id)).toEqual([id]);
  });

  it("keeps every report page on the same sandbox and advertiser", async () => {
    fetcher.mockImplementation(async input => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return response({ list: [{ advertiser_id: id, spend: String(page) }], page_info: { page, total_page: 2, page_size: 1, total_number: 2 } });
    });
    const rows = await client().fetchAllPages({ type: "basic", advertiser_id: id, service_type: "AUCTION", report_type: "BASIC", data_level: "AUCTION_ADVERTISER", dimensions: ["advertiser_id"], metrics: ["spend"], start_date: "2026-10-01", end_date: "2026-10-02", page_size: 1 } as never);
    expect(rows.map(row => row.spend)).toEqual(["1", "2"]);
    sandboxCalls(2);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it.each([
    ["tiktok_get_advertiser_info", { advertiserIds: [id, "999"] }],
    ["tiktok_health_check", { advertiserId: "999" }],
    ["tiktok_get_campaigns", { advertiserId: "999" }],
    ["tiktok_get_read_endpoint", { endpoint: "identity/get", parameters: { advertiser_id: "999" } }],
    ["tiktok_get_read_endpoint", { endpoint: "identity/get", parameters: {} }],
  ])("refuses foreign or unbound %s before any fetch", async (name, args) => {
    expect((await invoke(name as string, args as Record<string, unknown>)).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    `https://business-api.tiktok.com/open_api/v1.3/ad/get/?advertiser_id=${id}`,
    `https://sandbox-ads.tiktok.com.evil.example/open_api/v1.3/ad/get/?advertiser_id=${id}`,
    `https://sandbox-ads.tiktok.com/open_api/v1.2/ad/get/?advertiser_id=${id}`,
    `ad/get/?advertiser_id=${id}&advertiser_id=999`,
    `ad/get/?advertiser_id=${id}&advertiser_ids=["999"]`,
    `ad/get/?advertiser_ids=[${id}]`,
    "ad/get/?advertiser_ids=[]", "ad/get/?advertiser_ids=invalid", "ad/get/",
    `oauth2/advertiser/get/?advertiser_id=${id}`, `bc/advertiser/get/?advertiser_id=${id}`,
  ])("refuses unsafe URL/scope %s without network", async endpoint => {
    await expect(client().fetchUrl(endpoint)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { tiktokEnvironment: "staging" }, { tiktokEnvironment: "" }, { tiktokEnvironment: null },
    { tiktokEnvironment: "sandbox" }, { tiktokEnvironment: "sandbox", sandboxAdvertiserId: "bad" },
    { tiktokEnvironment: "sandbox", sandboxAdvertiserId: "999" },
  ])("fails closed for invalid environment/binding %j", async scope => {
    await expect(client(scope).fetchUrl(`ad/get/?advertiser_id=${id}`)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a conflicting default advertiser before any read", async () => {
    expect((await invoke("tiktok_get_advertiser_info", { advertiserIds: [id] }, { ...config, defaultAdvertiserId: "999" })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["provider-error", "redirect"])("never falls back to production after %s", async kind => {
    fetcher.mockImplementation(async () => kind === "redirect" ? new Response(null, { status: 302, headers: { location: `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/` } }) : Response.json({ code: 40010, message: "Unsupported sandbox endpoint" }));
    expect((await invoke("tiktok_get_advertiser_info", { advertiserIds: [id] })).isError).toBe(true);
    sandboxCalls(1);
  });

  it("retains production defaults and its existing OAuth advertiser discovery", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tiktokEnvironment, sandboxAdvertiserId, ...production } = config;
    await invoke("tiktok_get_advertiser_info", { advertiserIds: [id] }, production);
    await invoke("tiktok_list_advertisers", {}, production);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.every(url => url.origin === "https://business-api.tiktok.com")).toBe(true);
    expect(urls[1].pathname).toBe("/open_api/v1.3/oauth2/advertiser/get/");
    expect(urls[1].searchParams.get("app_id")).toBe("fixture-app");
    expect(urls[1].searchParams.get("secret")).toBe("fixture-secret");
    expect(() => assertSafeTikTokApiUrl(`https://sandbox-ads.tiktok.com/open_api/v1.3/ad/get/`)).toThrow();
  });
});
