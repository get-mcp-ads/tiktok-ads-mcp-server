/**
 * tiktok-ads-mcp-server: an open-source MCP server for the TikTok Business API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// TIKTOK BUSINESS API CLIENT (READ-ONLY)
// ============================================
// Standalone HTTP client for TikTok Business API
// TikTok Business API client. Read paths only; writes live in writes.ts.

import { parseTikTokJson } from "../../core/tiktok-json.js";
import { logger } from "../../core/logger.js";
import { RateLimiter } from "../../core/rate-limiter.js";
import {
  TikTokApiRequest,
  TikTokApiResponse,
  TikTokInsightRow,
  TikTokAdvertisersResponse,
  TikTokQueryPlan,
} from "./types.js";
import { mergeResults, buildRequestBody } from "./query-planner.js";
import { enrichWithCalculatedMetrics } from "./calculated-metrics.js";
import { findMissingMetricsInRow, getNativeMetrics } from "./metric-catalog.js";
import { NO_REDIRECT, refuseRedirect } from "../../core/redirects.js";
import { REQUEST_TIMEOUT_MS, readBoundedText, tiktokApiBase, type TikTokEnvironment } from "../../core/hosts.js";

type TikTokReadScope = { tiktokEnvironment?: TikTokEnvironment; sandboxAdvertiserId?: string };

/**
 * Reference catalogs that carry no advertiser data, so a request may omit the
 * advertiser selector. Every other read must name an allowed advertiser.
 */
const REFERENCE_PATHS = new Set([
  "tool/action_category", "tool/carrier", "tool/device_model", "tool/interest_category", "tool/language",
  "tool/os_version", "tool/phone_region_code", "tool/region", "tool/targeting/list", "tool/timezone",
  "search/region", "targeting/search",
]);
/** Token-wide discovery. Its response is filtered to the allowlist before anything else sees it. */
const DISCOVERY_PATH = "oauth2/advertiser/get";

/** Prevent Access-Token forwarding across hosts, environments or API versions. */
export function assertSafeTikTokApiUrl(rawEndpoint: string, environment: TikTokEnvironment = "production"): URL {
  const base = tiktokApiBase(environment);
  let url: URL;
  try {
    if (/^https?:\/\//i.test(rawEndpoint)) {
      url = new URL(rawEndpoint);
    } else {
      const relative = rawEndpoint
        .replace(/^\/+/, "")
        .replace(/^open_api\/v1\.3\//, "");
      url = new URL(relative, `${base}/`);
    }
  } catch {
    throw new Error("TikTok endpoint must be a valid relative path or official API URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== new URL(base).hostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("TikTok API reads are restricted to the configured environment's official host.");
  }
  if (!url.pathname.startsWith("/open_api/v1.3/")) {
    throw new Error("TikTok API reads are restricted to /open_api/v1.3/.");
  }
  return url;
}

// ============================================
// ERROR HANDLING
// ============================================

export class TikTokApiException extends Error {
  code: number;
  requestId: string;

  constructor(message: string, code: number, requestId: string) {
    super(message);
    this.name = "TikTokApiException";
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * TikTok API error codes
 */
export const ERROR_CODES = {
  OK: 0,
  SYSTEM_ERROR: 40001,
  INVALID_PARAMS: 40002,
  AUTHENTICATION_ERROR: 40100,
  NO_PERMISSION: 40101,
  RATE_LIMIT_EXCEEDED: 40301,
  RESOURCE_NOT_FOUND: 40400,
} as const;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Flatten TikTok API response row from nested structure to flat object
 * TikTok returns: { metrics: { clicks: "100", spend: "50.00" }, dimensions: { ad_id: "123" } }
 * We flatten to: { clicks: "100", spend: "50.00", ad_id: "123" }
 */
function flattenTikTokRow(row: TikTokInsightRow): TikTokInsightRow {
  const flattened: TikTokInsightRow = {};

  // Flatten metrics object
  if (row.metrics && typeof row.metrics === "object") {
    Object.entries(row.metrics).forEach(([key, value]) => {
      flattened[key] = value;
    });
  }

  // Flatten dimensions object
  if (row.dimensions && typeof row.dimensions === "object") {
    Object.entries(row.dimensions).forEach(([key, value]) => {
      flattened[key] = value;
    });
  }

  // Copy any other top-level properties
  Object.entries(row).forEach(([key, value]) => {
    if (key !== "metrics" && key !== "dimensions") {
      flattened[key] = value;
    }
  });

  return flattened;
}

const API_FIELD_TO_CANONICAL_METRIC = new Map(
  getNativeMetrics()
    .filter((metric) => metric.apiField && metric.apiField !== metric.key)
    .map((metric) => [metric.apiField, metric.key] as const),
);

function canonicalizeMetricAliases(row: TikTokInsightRow): TikTokInsightRow {
  const canonicalized: TikTokInsightRow = { ...row };
  for (const [apiField, canonicalKey] of API_FIELD_TO_CANONICAL_METRIC.entries()) {
    if (canonicalized[apiField] !== undefined && canonicalized[canonicalKey] === undefined) {
      canonicalized[canonicalKey] = canonicalized[apiField];
    }
    if (apiField === "total_complete_payment_rate" && canonicalKey === "total_complete_payment_value") {
      delete canonicalized[apiField];
    }
  }
  return canonicalized;
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/([?&](?:access_token|secret|app_secret)=)[^&]+/gi, "$1[redacted]")
      .replace(/(Access-Token["']?\s*:\s*["'])[^"']+/gi, "$1[redacted]");
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /token|secret/i.test(key) ? "[redacted]" : redactSecrets(entry),
      ])
    );
  }

  return value;
}

// ============================================
// API CLIENT
// ============================================

export class TikTokClient {
  private accessToken: string;
  private apiVersion: string;
  public readonly defaultAdvertiserId?: string;
  public readonly appId?: string;
  public readonly appSecret?: string;
  private rateLimiter = new RateLimiter();
  private readonly environment: TikTokEnvironment;
  private readonly sandboxAdvertiserId?: string;

  /**
   * allowedAccountIds is the TIKTOK_ADVERTISER_IDS allowlist. When it is set,
   * it is checked before every request and an empty list refuses every request.
   * Undefined keeps the 2.0 behaviour: every advertiser the token reaches.
   */
  constructor(accessToken: string, defaultAdvertiserId?: string, apiVersion: string = "v1.3", appId?: string, appSecret?: string, private readonly allowedAccountIds?: readonly string[], scope: TikTokReadScope = {}) {
    this.environment = scope.tiktokEnvironment === undefined ? "production" : scope.tiktokEnvironment;
    this.sandboxAdvertiserId = scope.sandboxAdvertiserId;
    this.accessToken = accessToken;
    this.defaultAdvertiserId = defaultAdvertiserId ?? (this.environment === "sandbox" ? this.sandboxAdvertiserId : undefined);
    this.apiVersion = apiVersion;
    this.appId = appId;
    this.appSecret = appSecret;
  }

  private isAllowed(id: string): boolean {
    return this.allowedAccountIds === undefined || this.allowedAccountIds.includes(id);
  }

  /** Refuses, before any network call, an advertiser outside the allowlist or the sandbox binding. */
  public assertAdvertiserScope(ids: string[]): void {
    tiktokApiBase(this.environment);
    if (this.allowedAccountIds !== undefined && !this.allowedAccountIds.length) {
      throw new Error("TIKTOK_ADVERTISER_IDS is empty, so no advertiser may be accessed. Nothing was sent.");
    }
    if (this.environment === "sandbox" && (typeof this.sandboxAdvertiserId !== "string" || !/^\d+$/.test(this.sandboxAdvertiserId) ||
      !this.isAllowed(this.sandboxAdvertiserId) || this.defaultAdvertiserId !== this.sandboxAdvertiserId)) {
      throw new Error("TikTok sandbox requires a selected, bound advertiser ID.");
    }
    if (this.environment === "sandbox" && (!ids.length || ids.some(id => id !== this.sandboxAdvertiserId))) {
      throw new Error("TikTok sandbox reads are restricted to the bound advertiser.");
    }
    const foreign = ids.filter(id => !this.isAllowed(id));
    if (foreign.length) {
      throw new Error(`Advertiser ${foreign.join(", ")} is not in TIKTOK_ADVERTISER_IDS. Nothing was sent.`);
    }
  }

  private scopedUrl(endpoint: string): URL {
    const url = assertSafeTikTokApiUrl(endpoint, this.environment);
    const ids = url.searchParams.getAll("advertiser_id");
    for (const raw of url.searchParams.getAll("advertiser_ids")) {
      let values: unknown;
      try { values = JSON.parse(raw); } catch { throw new Error("Invalid TikTok advertiser_ids."); }
      if (!Array.isArray(values) || !values.length || values.some(id => typeof id !== "string")) throw new Error("Invalid TikTok advertiser_ids.");
      ids.push(...values);
    }
    const path = url.pathname.replace(/^\/open_api\/v1\.3\//, "").replace(/\/+$/, "");
    if (this.environment === "sandbox") {
      this.assertAdvertiserScope(ids);
      // Sandbox credentials cannot be used for OAuth or Business Center discovery,
      // even if a caller adds an otherwise valid advertiser selector.
      if (/^\/open_api\/v1\.3\/(?:oauth2|bc)\//.test(url.pathname)) throw new Error("TikTok sandbox discovery is limited to the bound advertiser.");
    } else if (ids.length) {
      this.assertAdvertiserScope(ids);
    } else if (this.allowedAccountIds !== undefined) {
      this.assertAdvertiserScope([]);
      if (path !== DISCOVERY_PATH && !REFERENCE_PATHS.has(path)) {
        throw new Error("Pass advertiserId: every TikTok request must name an advertiser from TIKTOK_ADVERTISER_IDS. Nothing was sent.");
      }
    }
    return url;
  }

  /** Discovery responses can list advertisers outside the allowlist. They never leave the client. */
  private dropForeignAdvertisers<T>(data: T): T {
    if (this.allowedAccountIds === undefined) return data;
    const payload = data as { data?: { list?: unknown } } | undefined;
    const list = payload?.data?.list;
    if (!Array.isArray(list)) return data;
    const kept = list.filter(row => {
      const id = row && typeof row === "object" ? (row as Record<string, unknown>).advertiser_id : undefined;
      return id === undefined || id === null || this.isAllowed(String(id));
    });
    if (kept.length === list.length) return data;
    return { ...payload, data: { ...payload!.data, list: kept } } as T;
  }

  /** Provider error text can echo a credential. It is redacted before it reaches a log or the model. */
  private scrub(text: string): string {
    let out = text;
    for (const secret of [this.accessToken, this.appSecret]) {
      if (secret) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  private async send(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: NO_REDIRECT, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      refuseRedirect(response, "TikTok Business API");
    } catch (error) {
      if (error instanceof Error && /redirect/.test(error.message)) throw error;
      throw new Error("TikTok could not be reached or did not answer in time. Retry later.");
    }
    logger.debug("tiktok", `Response status: ${response.status}`);

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = this.scrub(await readBoundedText(response));
        logger.error("tiktok", `Error response body: ${errorBody.slice(0, 2000)}`);
      } catch {
        logger.error("tiktok", "Could not read error body");
      }
      throw new TikTokApiException(
        `HTTP error ${response.status}: ${response.statusText}. Body: ${errorBody.substring(0, 200)}`,
        response.status,
        ""
      );
    }

    const data = parseTikTokJson(await readBoundedText(response)) as Record<string, unknown>;
    logger.debug("tiktok", `Response code: ${data.code}`);

    // TikTok answers HTTP 200 even when the call failed: the code field decides.
    if (data.code !== 0) {
      throw new TikTokApiException(
        this.scrub(String((data.message as string) || "Unknown API error")),
        data.code as number,
        (data.request_id as string) || ""
      );
    }
    return this.dropForeignAdvertisers(data);
  }

  /**
   * Make a request to the TikTok API
   */
  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = this.scopedUrl(endpoint);
    if (body && typeof body.advertiser_id === "string") this.assertAdvertiserScope([body.advertiser_id]);
    return this.rateLimiter.execute(async () => {
      logger.debug("tiktok", `${method} ${redactSecrets(url.toString())}`);
      if (body) {
        logger.debug("tiktok", `Body: ${JSON.stringify(redactSecrets(body), null, 2)}`);
      }

      const headers: Record<string, string> = {
        "Access-Token": this.accessToken,
        "Content-Type": "application/json",
      };
      logger.debug("tiktok", "Access-Token: [redacted]");

      const data = await this.send(url, {
        method,
        headers,
        redirect: NO_REDIRECT,
        ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      return data as T;
    });
  }

  // ============================================
  // GENERIC URL FETCH (for arbitrary API calls)
  // ============================================

  /**
   * Fetch an arbitrary TikTok API URL.
   * Useful for generic/exploratory calls from MCP tools.
   */
  public async fetchUrl(endpoint: string): Promise<unknown> {
    const url = this.scopedUrl(endpoint);
    return this.rateLimiter.execute(async () => {
      const safeUrl = String(redactSecrets(url.toString()));
      logger.debug("tiktok", `fetchUrl GET ${safeUrl.slice(0, 120)}`);

      const headers: Record<string, string> = {
        "Access-Token": this.accessToken,
        "Content-Type": "application/json",
      };

      return this.send(url, { method: "GET", headers, redirect: NO_REDIRECT });
    });
  }

  // ============================================
  // ADVERTISER METHODS
  // ============================================

  /**
   * Get the advertiser accounts accessible to the current token, limited to TIKTOK_ADVERTISER_IDS
   */
  async getAdvertisers(): Promise<TikTokAdvertisersResponse> {
    if (this.environment === "sandbox") {
      const response = await this.request<TikTokAdvertisersResponse>(`advertiser/info/?${new URLSearchParams({ advertiser_ids: JSON.stringify([this.sandboxAdvertiserId]) })}`);
      return { ...response, data: { list: response.data.list.filter(account => account.advertiser_id === this.sandboxAdvertiserId) } };
    }
    const params: Record<string, string> = {
      access_token: this.accessToken,
    };
    if (this.appId) params.app_id = this.appId;
    if (this.appSecret) params.secret = this.appSecret;
    const qs = new URLSearchParams(params).toString();
    const response = await this.request<TikTokAdvertisersResponse>(
      `${DISCOVERY_PATH}/?${qs}`, "GET"
    );
    return { ...response, data: { list: (response.data?.list ?? []).filter(account => this.isAllowed(String(account.advertiser_id))) } };
  }

  /**
   * Get advertiser info by IDs (supports multiple)
   */
  async getAdvertiserInfo(advertiserIds: string | string[]): Promise<{
    code: number;
    message: string;
    data: {
      list: Array<{
        advertiser_id: string;
        advertiser_name: string;
        status: string;
        currency: string;
        timezone: string;
        create_time: number;
      }>;
    };
  }> {
    const ids = Array.isArray(advertiserIds) ? advertiserIds : [advertiserIds];
    return this.request(
      `advertiser/info/?${new URLSearchParams({ advertiser_ids: JSON.stringify(ids) })}`,
      "GET"
    );
  }

  // ============================================
  // ENTITY METHODS (for name enrichment)
  // ============================================

  /**
   * Fetch campaigns by IDs, returns id->name map
   */
  /**
   * Exécute des lots en parallèle, mais pas tous à la fois.
   *
   * Ces trois méthodes enchaînaient leurs lots en série. Sur un compte de huit
   * cents annonces cela fait neuf requêtes l'une après l'autre, et l'ensemble
   * dépassait le délai : toute demande de métriques au niveau annonce échouait,
   * alors que le niveau campagne, qui tient en une requête, répondait. Le
   * symptôme ne désignait rien, puisque l'erreur venait du temps total et pas
   * d'un appel identifiable.
   *
   * Quatre de front, et pas davantage : TikTok limite le débit par compte, et
   * lancer neuf requêtes simultanées échangerait une panne de délai contre une
   * panne de quota.
   */
  private async inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
    }
    return out;
  }

  async getCampaignNames(advertiserId: string, campaignIds: string[]): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();
    if (campaignIds.length === 0) return nameMap;

    // TikTok allows max 100 IDs per request
    const chunks = [];
    for (let i = 0; i < campaignIds.length; i += 100) {
      chunks.push(campaignIds.slice(i, i + 100));
    }

    await this.inBatches(chunks, 4, async (chunk) => {
      try {
        const params = new URLSearchParams();
        params.set("advertiser_id", advertiserId);
        params.set("filtering", JSON.stringify({ campaign_ids: chunk }));
        params.set("fields", JSON.stringify(["campaign_id", "campaign_name"]));
        params.set("page_size", "100");

        const response = await this.request<{
          code: number;
          data: { list: Array<{ campaign_id: string; campaign_name: string }> };
        }>(`campaign/get/?${params.toString()}`, "GET");

        response.data?.list?.forEach((c) => {
          nameMap.set(String(c.campaign_id), c.campaign_name);
        });
      } catch (e) {
        logger.warn("tiktok", "Failed to fetch campaign names", e);
      }
    });
    return nameMap;
  }

  /**
   * Fetch ad groups by IDs, returns id->name map
   */
  async getAdGroupNames(advertiserId: string, adGroupIds: string[]): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();
    if (adGroupIds.length === 0) return nameMap;

    const chunks = [];
    for (let i = 0; i < adGroupIds.length; i += 100) {
      chunks.push(adGroupIds.slice(i, i + 100));
    }

    await this.inBatches(chunks, 4, async (chunk) => {
      try {
        const params = new URLSearchParams();
        params.set("advertiser_id", advertiserId);
        params.set("filtering", JSON.stringify({ adgroup_ids: chunk }));
        params.set("fields", JSON.stringify(["adgroup_id", "adgroup_name"]));
        params.set("page_size", "100");

        const response = await this.request<{
          code: number;
          data: { list: Array<{ adgroup_id: string; adgroup_name: string }> };
        }>(`adgroup/get/?${params.toString()}`, "GET");

        response.data?.list?.forEach((g) => {
          nameMap.set(String(g.adgroup_id), g.adgroup_name);
        });
      } catch (e) {
        logger.warn("tiktok", "Failed to fetch adgroup names", e);
      }
    });
    return nameMap;
  }

  /**
   * Les annonces par identifiant : leur nom, et les assets qu'elles utilisent.
   *
   * Les deux ensemble, dans la même requête, parce que `/ad/get/` les rend
   * ensemble. Joindre des métriques à des créatives demandait sinon un appel
   * de plus par lot, sur un endpoint plafonné à cinquante annonces, ce qui ne
   * tenait pas sur un compte qui en a près de six cents. Ici c'est gratuit :
   * deux champs ajoutés à un appel qui a lieu de toute façon.
   *
   * L'identifiant plutôt que le nom, aussi, parce que deux annonces d'une même
   * créative portent des noms différents dès que le nom encode la campagne. Le
   * nom sert à lire, l'identifiant à joindre.
   */
  async getAdDetails(
    advertiserId: string,
    adIds: string[],
  ): Promise<Map<string, { name: string; assets: string[] }>> {
    const details = new Map<string, { name: string; assets: string[] }>();
    if (adIds.length === 0) return details;

    const chunks = [];
    for (let i = 0; i < adIds.length; i += 100) {
      chunks.push(adIds.slice(i, i + 100));
    }

    await this.inBatches(chunks, 4, async (chunk) => {
      try {
        const params = new URLSearchParams();
        params.set("advertiser_id", advertiserId);
        params.set("filtering", JSON.stringify({ ad_ids: chunk, primary_status: "STATUS_ALL" }));
        params.set("fields", JSON.stringify(["ad_id", "ad_name", "video_id", "image_ids"]));
        params.set("page_size", "100");

        const response = await this.request<{
          code: number;
          data: {
            list: Array<{ ad_id: string; ad_name: string; video_id?: string; image_ids?: string[] }>;
          };
        }>(`ad/get/?${params.toString()}`, "GET");

        response.data?.list?.forEach((a) => {
          const assets: string[] = [];
          const video = typeof a.video_id === "string" && a.video_id ? a.video_id : null;
          if (video) assets.push(video);

          // Une annonce vidéo range sa propre couverture dans `image_ids`.
          //
          // Vérifié sur le compte de test : chaque annonce vidéo rend deux
          // entrées, l'identifiant de la vidéo et le chemin de sa vignette. La
          // compter comme un visuel distinct faisait croire à un partage
          // d'annonce, donc à une dépense comptée plusieurs fois, sur des
          // créatives qui ne partagent rien. Quand il y a une vidéo, les images
          // de l'annonce sont sa couverture et non des créatives.
          if (!video && Array.isArray(a.image_ids)) {
            assets.push(...a.image_ids.map(String).filter(Boolean));
          }
          details.set(String(a.ad_id), { name: a.ad_name, assets });
        });
      } catch (e) {
        logger.warn("tiktok", "Failed to fetch ad details", e);
      }
    });
    return details;
  }

  /**
   * Enrich result rows with entity names (campaign_name, adgroup_name, ad_name)
   */
  async enrichWithEntityNames(
    rows: TikTokInsightRow[],
    advertiserId: string
  ): Promise<TikTokInsightRow[]> {
    if (rows.length === 0) return rows;

    const sampleRow = rows[0];
    const hasCampaignId = "campaign_id" in sampleRow;
    const hasAdGroupId = "adgroup_id" in sampleRow;
    const hasAdId = "ad_id" in sampleRow;

    // Collect unique IDs
    const campaignIds = hasCampaignId ? [...new Set(rows.map((r) => String(r.campaign_id)).filter(Boolean))] : [];
    const adGroupIds = hasAdGroupId ? [...new Set(rows.map((r) => String(r.adgroup_id)).filter(Boolean))] : [];
    const adIds = hasAdId ? [...new Set(rows.map((r) => String(r.ad_id)).filter(Boolean))] : [];

    logger.info("tiktok", `Enriching: ${campaignIds.length} campaigns, ${adGroupIds.length} adgroups, ${adIds.length} ads`);

    // Fetch names in parallel
    const [campaignNames, adGroupNames, adNames] = await Promise.all([
      campaignIds.length > 0 ? this.getCampaignNames(advertiserId, campaignIds) : new Map<string, string>(),
      adGroupIds.length > 0 ? this.getAdGroupNames(advertiserId, adGroupIds) : new Map<string, string>(),
      adIds.length > 0
        ? this.getAdDetails(advertiserId, adIds)
        : new Map<string, { name: string; assets: string[] }>(),
    ]);

    // Enrich rows
    return rows.map((row) => {
      const enriched = { ...row };
      if (hasCampaignId && row.campaign_id) {
        enriched.campaign_name = campaignNames.get(String(row.campaign_id)) || "";
      }
      if (hasAdGroupId && row.adgroup_id) {
        enriched.adgroup_name = adGroupNames.get(String(row.adgroup_id)) || "";
      }
      if (hasAdId && row.ad_id) {
        const ad = adNames.get(String(row.ad_id));
        enriched.ad_name = ad?.name ?? "";
        // Les assets utilisés par cette annonce, ramenés sans requête de plus.
        // C'est ce qui permet de joindre des métriques à des visuels : sans
        // eux, une ligne de rapport ne sait pas à quoi elle ressemble.
        if (ad && ad.assets.length > 0) enriched.asset_ids = ad.assets;
      }
      return enriched;
    });
  }

  // ============================================
  // REPORTING METHODS
  // ============================================

  /**
   * Execute a basic report query
   * TikTok Business API report/integrated/get uses GET with URL parameters
   * Arrays (dimensions, metrics, filtering) are JSON-stringified in URL params
   *
   * NOTE: Date parameters (start_date, end_date) are handled by buildRequestBody:
   * - For non-lifetime queries: dates are required and included
   * - For lifetime queries: dates are NOT included (TikTok may reject them)
   */
  async fetchBasicReport(request: TikTokApiRequest): Promise<TikTokApiResponse> {
    const body = buildRequestBody(request);
    logger.debug("tiktok", `fetchBasicReport params: ${JSON.stringify(body, null, 2)}`);

    // Build URL parameters - TikTok expects JSON-encoded arrays
    const params = new URLSearchParams();
    params.set("advertiser_id", String(body.advertiser_id));
    params.set("service_type", String(body.service_type || "AUCTION"));
    params.set("report_type", String(body.report_type || "BASIC"));
    params.set("data_level", String(body.data_level));
    params.set("dimensions", JSON.stringify(body.dimensions));
    params.set("metrics", JSON.stringify(body.metrics));

    // Dates are only in body if NOT a lifetime query (handled by buildRequestBody)
    if (body.start_date) {
      params.set("start_date", String(body.start_date));
    }
    if (body.end_date) {
      params.set("end_date", String(body.end_date));
    }
    if (body.page) {
      params.set("page", String(body.page));
    }
    if (body.page_size) {
      params.set("page_size", String(body.page_size));
    }
    if (body.query_lifetime) {
      params.set("query_lifetime", "true");
    }
    if (body.filtering && Array.isArray(body.filtering) && body.filtering.length > 0) {
      params.set("filtering", JSON.stringify(body.filtering));
    }
    if (body.order_field) {
      params.set("order_field", String(body.order_field));
      params.set("order_type", String(body.order_type || "DESC"));
    }

    logger.debug("tiktok", `Request URL params: ${params.toString()}`);

    return this.request<TikTokApiResponse>(
      `report/integrated/get/?${params.toString()}`,
      "GET"
    );
  }

  /**
   * Execute a query with automatic pagination
   */
  async fetchAllPages(request: TikTokApiRequest): Promise<TikTokInsightRow[]> {
    const allRows: TikTokInsightRow[] = [];
    let currentPage = 1;
    let hasMore = true;

    // Le plafond de lignes, et le plafond de pages qui en découle.
    //
    // Un Worker n'a droit qu'à cinquante sous-requêtes par invocation, toutes
    // confondues : la base, les jetons, et chaque page de rapport. Dépasser ne
    // rend pas une réponse partielle, ça tue l'invocation entière. Le garde
    // précédent était fixé à cent pages, soit le double de ce que le runtime
    // autorise, donc il ne gardait rien.
    const maxRows = typeof request.max_rows === "number" ? request.max_rows : Infinity;
    const MAX_PAGES = 8;

    while (hasMore) {
      const pageRequest = { ...request, page: currentPage };
      const response = await this.fetchBasicReport(pageRequest);

      if (response.data?.list) {
        allRows.push(...response.data.list);
      }

      // Check if there are more pages
      const pageInfo = response.data?.page_info;
      if (pageInfo) {
        if (currentPage === 1) {
          logger.info("tiktok", `Pagination: total_page=${pageInfo.total_page}, total_number=${pageInfo.total_number}, page_size=${pageInfo.page_size}`);
        }
        hasMore = currentPage < pageInfo.total_page;
        currentPage++;
      } else {
        hasMore = false;
      }

      if (allRows.length >= maxRows) break;

      if (currentPage > MAX_PAGES) {
        logger.warn("tiktok", `Stopped at ${MAX_PAGES} pages to stay inside the Worker subrequest budget`);
        break;
      }
    }

    logger.info("tiktok", `fetchAllPages complete: ${allRows.length} total rows across ${currentPage - 1} pages`);
    return allRows;
  }

  /**
   * Execute a planned query with result merging
   */
  async executeQueryPlan(
    plan: TikTokQueryPlan,
    fetchAll: boolean = false
  ): Promise<{
    data: TikTokInsightRow[];
    debug: {
      requestCount: number;
      totalRows: number;
      executionTimeMs: number;
      warnings: string[];
    };
  }> {
    const startTime = Date.now();
    const resultSets: TikTokInsightRow[][] = [];

    // Execute all requests
    for (const request of plan.requests) {
      try {
        const rows = fetchAll
          ? await this.fetchAllPages(request)
          : (await this.fetchBasicReport(request)).data?.list || [];
        resultSets.push(rows);
      } catch (error) {
        logger.error("tiktok", "Error executing TikTok API request", error);
        throw error;
      }
    }

    // Flatten nested TikTok response structure (metrics/dimensions objects)
    logger.debug("tiktok", `Raw result sets count: ${resultSets.length}`);
    if (resultSets.length > 0 && resultSets[0].length > 0) {
      logger.debug("tiktok", `Raw first row before flatten: ${JSON.stringify(resultSets[0][0], null, 2)}`);
    }

    const flattenedResults = resultSets.map(rows =>
      rows.map(row => flattenTikTokRow(row))
    );

    if (flattenedResults.length > 0 && flattenedResults[0].length > 0) {
      logger.debug("tiktok", `First row after flatten: ${JSON.stringify(flattenedResults[0][0], null, 2)}`);
    }

    // Merge results
    let mergedData = mergeResults(flattenedResults, plan.joinKeys);
    logger.debug("tiktok", `Merged data rows: ${mergedData.length}`);
    if (mergedData.length > 0) {
      logger.debug("tiktok", `Merged row keys: ${Object.keys(mergedData[0])}`);
    }

    // Enrich with calculated metrics
    logger.debug("tiktok", `Calculated metrics to add: ${plan.calculatedMetrics}`);
    if (plan.calculatedMetrics.length > 0) {
      mergedData = enrichWithCalculatedMetrics(mergedData, plan.calculatedMetrics);
      logger.debug("tiktok", `After enrichment, row keys: ${mergedData.length > 0 ? Object.keys(mergedData[0]) : []}`);
    }

    mergedData = mergedData.map(row => canonicalizeMetricAliases(row));

    // Debug: Check which metrics are missing from the response
    if (mergedData.length > 0) {
      const allRequestedMetrics = plan.requests.flatMap((r) => r.metrics);
      const missingMetrics = findMissingMetricsInRow(allRequestedMetrics, mergedData[0]);
      if (missingMetrics.length > 0) {
        logger.warn("tiktok", `Metrics with no data in response: ${missingMetrics}`);
      } else {
        logger.debug("tiktok", "All requested metrics have data in response");
      }
    }

    const executionTimeMs = Date.now() - startTime;

    return {
      data: mergedData,
      debug: {
        requestCount: plan.requests.length,
        totalRows: mergedData.length,
        executionTimeMs,
        warnings: plan.warnings,
      },
    };
  }
}
