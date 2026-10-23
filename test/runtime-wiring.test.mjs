/**
 * The runtime check only protects users if the entry points run it, and only
 * on stderr: stdout carries the MCP protocol, so a stray line there breaks
 * every client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the CLI writes the runtime warning to stderr, never to stdout", () => {
  const cli = read("src/cli.ts");
  assert.match(cli, /import \{ nodeRuntimeWarning \} from "\.\/runtime-check\.js";/);
  assert.match(cli, /nodeRuntimeWarning\(\)/);
  assert.match(cli, /process\.stderr\.write\(/);
  assert.doesNotMatch(cli, /console\.log|process\.stdout/);
});

test("the doctor reports the same runtime check", () => {
  const doctor = read("scripts/doctor.mjs");
  assert.match(doctor, /nodeRuntimeWarning\(/);
  assert.match(doctor, /dist\/runtime-check\.js/);
  assert.match(read("tsup.config.ts"), /src\/runtime-check\.ts/);
});
