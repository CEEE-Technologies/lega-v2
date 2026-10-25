import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle } from "../dist/bundle.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(...args) {
  assert.equal(existsSync(cli), true, "CLI must exist");
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("QBO_")) delete env[key];
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    env,
  });
}
test("CLI help and malformed arguments work without services or credentials", () => {
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /connect/);
  assert.match(help.stdout, /resume/);
  const unknown = run("extract", "--page-size", "secret-value");
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stderr.includes("secret-value"), false);
  assert.notEqual(run("extract").status, 0);
});
test("CLI status and validation read local bundles offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lega-qbo-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, "export");
  await createBundle(out, {
    realmId: "123",
    environment: "sandbox",
    minorVersion: "75",
  });
  const status = run("status", "--out", out);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /extracting/);
  const invalid = run("validate", "--out", out);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /incomplete/);
});
