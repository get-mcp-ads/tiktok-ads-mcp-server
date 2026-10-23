/**
 * tiktok-ads-mcp-server: an open-source MCP server for the TikTok Business API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The only API bases this server sends a request to, one per TikTok
 * environment. Read and write clients both resolve their host here, so a tool
 * argument can never switch hosts, environments or API versions.
 */
export const TIKTOK_API_BASE_URLS = {
  production: "https://business-api.tiktok.com/open_api/v1.3",
  sandbox: "https://sandbox-ads.tiktok.com/open_api/v1.3",
} as const;

export type TikTokEnvironment = keyof typeof TIKTOK_API_BASE_URLS;

export function tiktokApiBase(environment: unknown = "production"): string {
  if (environment === "production" || environment === "sandbox") return TIKTOK_API_BASE_URLS[environment];
  throw new Error("Invalid TikTok API environment. Use production or sandbox.");
}

/** Upper bound on one TikTok response body. A larger answer is refused, not buffered. */
export const MAX_RESPONSE_BYTES = 20_000_000;
/** Upper bound on one TikTok request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Reads a response body up to MAX_RESPONSE_BYTES, then stops. */
export async function readBoundedText(response: Response, api = "TikTok Business API"): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${api} response exceeds ${MAX_RESPONSE_BYTES / 1_000_000} MB. Narrow the date range or the page size.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`${api} response exceeds ${MAX_RESPONSE_BYTES / 1_000_000} MB. Narrow the date range or the page size.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
