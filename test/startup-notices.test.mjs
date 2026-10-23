/**
 * Version 2.1 keeps 2.0 setups working: no advertiser allowlist and the old
 * write-flag spellings still start the server. Each prints one notice about
 * the 3.0.0 change, on stderr only, because stdout carries the MCP protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function start(env) {
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TIKTOK_ACCESS_TOKEN: "token-for-notices", TIKTOK_APP_ID: "app-for-notices", LOG_LEVEL: "error", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "notices", version: "1" } } })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no initialize answer. stderr: ${stderr}`)); }, 15_000);
    child.stdout.on("data", () => {
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      child.kill();
      resolve({ stdout, stderr });
    });
  });
}

/** Plain-text notices, as opposed to the logger's JSON lines. */
const notices = (stderr) => stderr.split("\n").filter((line) => line && !line.startsWith("{"));

test("a 2.0 configuration starts and gets both notices on stderr, none on stdout", async () => {
  const { stdout, stderr } = await start({ TIKTOK_ENABLE_WRITES: "1", TIKTOK_ADVERTISER_IDS: "" });
  for (const line of stdout.trim().split("\n")) assert.equal(JSON.parse(line).jsonrpc, "2.0", `stdout carried a non-protocol line: ${line}`);
  assert.doesNotMatch(stdout, /TIKTOK_ADVERTISER_IDS|TIKTOK_ENABLE_WRITES/);
  const lines = notices(stderr);
  assert.equal(lines.filter((line) => /TIKTOK_ADVERTISER_IDS is not set.*required in 3\.0\.0/.test(line)).length, 1, stderr);
  assert.equal(lines.filter((line) => /TIKTOK_ENABLE_WRITES=1 is read as true.*from 3\.0\.0 only the exact value true/.test(line)).length, 1, stderr);
  assert.doesNotMatch(stderr, /token-for-notices/);
});

test("a 2.1 configuration starts without any configuration notice", async () => {
  const { stdout, stderr } = await start({ TIKTOK_ENABLE_WRITES: "true", TIKTOK_ADVERTISER_IDS: "1000000000000000001" });
  assert.equal(JSON.parse(stdout.trim().split("\n")[0]).id, 1);
  assert.deepEqual(notices(stderr).filter((line) => /TIKTOK_/.test(line)), []);
});
