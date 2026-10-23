/**
 * tiktok-ads-mcp-server: an open-source MCP server for the TikTok Business API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import { logger } from "./core/logger.js";

const configSchema = z.object({
  /** API environment. Sandbox reads and writes are bound to one advertiser. */
  tiktokEnvironment: z.enum(["production", "sandbox"]).optional(),
  accessToken: z.string().min(1, "TIKTOK_ACCESS_TOKEN is required"),
  appId: z.string().min(1, "TIKTOK_APP_ID is required"),
  appSecret: z.string().optional(),
  defaultAdvertiserId: z.string().optional(),
  /**
   * Advertisers this server may reach. When set, every request and discovery
   * response is checked against it. Undefined keeps the 2.0 behaviour: every
   * advertiser the token reaches.
   */
  allowedAccountIds: z.array(z.string().regex(/^\d{1,32}$/, "TIKTOK_ADVERTISER_IDS accepts numeric advertiser IDs only")).min(1).max(200).optional(),
  /** The single advertiser a sandbox token is bound to. */
  sandboxAdvertiserId: z.string().optional(),
  defaultBusinessCenterId: z.string().optional(),
  /** Write tools are registered only when this is true. */
  enableWrites: z.boolean().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type TikTokConfig = z.infer<typeof configSchema>;

/** Spellings 2.0 read as true. Still accepted, with a deprecation notice, until 3.0.0. */
const LEGACY_TRUE = ["1", "yes", "on"];

/** Writes one line to stderr. stdout carries the MCP protocol and never receives notices. */
const stderrLine = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * Reads the environment, validates it and fails at startup with the variable
 * to fix. Notices about deprecated or recommended settings go to `notice`,
 * which writes to stderr by default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, notice: (line: string) => void = stderrLine): TikTokConfig {
  const problems: string[] = [];

  const flag = (env["TIKTOK_ENABLE_WRITES"] ?? "").trim();
  const flagValue = flag.toLowerCase();
  const enableWrites = flagValue === "true" || LEGACY_TRUE.includes(flagValue);
  if (enableWrites && flag !== "true") {
    notice(`TIKTOK_ENABLE_WRITES=${flag} is read as true for now. Set TIKTOK_ENABLE_WRITES=true: from 3.0.0 only the exact value true enables writes.`);
  }

  const defaultAdvertiserId = env["TIKTOK_ADVERTISER_ID"]?.trim() || undefined;
  const listed = (env["TIKTOK_ADVERTISER_IDS"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const allowedAccountIds = listed.length ? [...new Set(listed)] : undefined;
  if (!allowedAccountIds) {
    notice("TIKTOK_ADVERTISER_IDS is not set, so every advertiser the token reaches is accessible. Set it to the comma-separated advertiser IDs this server may use: it becomes required in 3.0.0.");
  } else if (defaultAdvertiserId && !allowedAccountIds.includes(defaultAdvertiserId)) {
    problems.push("TIKTOK_ADVERTISER_ID must be one of TIKTOK_ADVERTISER_IDS");
  }

  const tiktokEnvironment = env["TIKTOK_ENVIRONMENT"]?.trim() || "production";
  const sandbox = tiktokEnvironment === "sandbox";
  if (sandbox && allowedAccountIds && allowedAccountIds.length !== 1) {
    problems.push("TIKTOK_ENVIRONMENT=sandbox needs exactly one advertiser in TIKTOK_ADVERTISER_IDS: the sandbox advertiser");
  }
  const sandboxAdvertiserId = sandbox ? allowedAccountIds?.[0] ?? defaultAdvertiserId : undefined;
  if (sandbox && !sandboxAdvertiserId) {
    notice("TIKTOK_ENVIRONMENT=sandbox has no advertiser to bind to, so sandbox calls are refused. Set TIKTOK_ADVERTISER_IDS to the sandbox advertiser ID.");
  }

  const raw = {
    tiktokEnvironment,
    accessToken: env["TIKTOK_ACCESS_TOKEN"] ?? "",
    appId: env["TIKTOK_APP_ID"] ?? "",
    appSecret: env["TIKTOK_APP_SECRET"] || undefined,
    defaultAdvertiserId: defaultAdvertiserId ?? (sandbox ? sandboxAdvertiserId : allowedAccountIds?.length === 1 ? allowedAccountIds[0] : undefined),
    allowedAccountIds,
    sandboxAdvertiserId,
    defaultBusinessCenterId: env["TIKTOK_BC_ID"] || env["TIKTOK_BUSINESS_CENTER_ID"] || undefined,
    enableWrites,
    logLevel: env["LOG_LEVEL"] ?? "info",
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    problems.push(...result.error.issues.map((issue) =>
      issue.path[0] === "tiktokEnvironment" ? "TIKTOK_ENVIRONMENT must be production or sandbox"
      : issue.path[0] === "allowedAccountIds" ? `TIKTOK_ADVERTISER_IDS accepts 1 to 200 numeric advertiser IDs (${issue.message})`
      : issue.path[0] === "logLevel" ? "LOG_LEVEL must be debug, info, warn or error"
      : issue.message));
  }
  if (problems.length || !result.success) {
    const message = `Invalid TikTok configuration: ${[...new Set(problems)].join("; ")}.`;
    logger.error("config", message);
    throw new Error(message);
  }

  return result.data;
}
