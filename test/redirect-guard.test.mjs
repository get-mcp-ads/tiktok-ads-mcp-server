/**
 * Every outbound call carries the TikTok access token. Following a redirect
 * would forward it to whatever host the redirect names, so no fetch in this
 * codebase may follow one: it either sets `redirect: "error"`, or sets
 * `redirect: NO_REDIRECT` ("manual") and refuses the 3xx answer itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

function sourceFiles(dir = "src", acc = []) {
  for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) sourceFiles(`${dir}/${entry.name}`, acc);
    else if (entry.name.endsWith(".ts")) acc.push(`${dir}/${entry.name}`);
  }
  return acc;
}

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("every fetch refuses to follow redirects", () => {
  const offenders = [];
  let calls = 0;

  for (const file of sourceFiles()) {
    const text = read(file);
    for (const match of text.matchAll(/\bfetch\(/g)) {
      calls++;
      // The options object of a fetch call ends at the first `});` that follows.
      const tail = text.slice(match.index, match.index + 1200);
      const end = tail.indexOf("});");
      const call = end === -1 ? tail : tail.slice(0, end);
      const after = text.slice(match.index + call.length, match.index + call.length + 400);
      const errors = /redirect:\s*"error"/.test(call);
      const refuses = /redirect:\s*NO_REDIRECT/.test(call) && /refuseRedirect\(/.test(after);
      if (!errors && !refuses) offenders.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }

  assert.ok(calls > 0, "no fetch call found: the scan itself is broken");
  assert.deepEqual(offenders, [], `These fetch calls may follow a redirect and leak credentials: ${offenders.join(", ")}`);
});

test("every fetch sets a timeout", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const text = read(file);
    for (const match of text.matchAll(/\bfetch\(/g)) {
      const tail = text.slice(match.index, match.index + 1200);
      const call = tail.slice(0, tail.indexOf("});") === -1 ? tail.length : tail.indexOf("});"));
      if (!/signal:\s*AbortSignal\.timeout\(/.test(call)) offenders.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [], `These fetch calls have no timeout: ${offenders.join(", ")}`);
});

test("the only hosts this server can reach are TikTok's, listed in one place", () => {
  const hosts = new Set();
  const bases = [];
  for (const file of sourceFiles()) {
    const text = read(file);
    for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const host = match[1].replace(/\.$/, "");
      // Product links in server metadata and comments are not call targets.
      if (host === "mcp.getmcpads.com" || host === "www.getmcpads.com" || host === "github.com") continue;
      hosts.add(host);
    }
    for (const match of text.matchAll(/https:\/\/[a-z0-9.-]+\/open_api/gi)) bases.push(`${file}:${match[0]}`);
  }
  assert.deepEqual(
    [...hosts].sort(),
    ["business-api.tiktok.com", "sandbox-ads.tiktok.com"],
    "A new outbound host appeared. That is a deliberate decision, not an accident.",
  );
  assert.ok(bases.length > 0 && bases.every((entry) => entry.startsWith("src/core/hosts.ts:")),
    `API base URLs must be declared only in src/core/hosts.ts: ${bases.join(", ")}`);
});
