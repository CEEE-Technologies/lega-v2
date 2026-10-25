import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A missing checksum check, unsafe path resolution, or optimistic completion
// would allow corrupted/source-incomplete data into the later importer.
const bundle = await import("../dist/bundle.js").catch(() => ({}));
const storage = await import("../dist/storage.js").catch(() => ({}));
const source = { realmId: "123", environment: "sandbox", minorVersion: "75" };
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "lega-qbo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("creates a private incomplete bundle and refuses overwrite", async (t) => {
  assert.equal(typeof bundle.createBundle, "function");
  const out = join(await temp(t), "export");
  const manifest = await bundle.createBundle(out, source);
  assert.equal(manifest.format, "lega-qbo-bundle");
  assert.equal(manifest.version, 1);
  await assert.rejects(bundle.validateBundle(out), /incomplete/);
  await assert.rejects(bundle.createBundle(out, source), /exists/);
});
test("retains nested raw fields, verifies pages, and detects tampering", async (t) => {
  assert.equal(typeof bundle.writePage, "function");
  const out = join(await temp(t), "export");
  const m = await bundle.createBundle(out, source);
  const raw = { Id: "7", DisplayName: "A", Extra: { FutureField: [1, 2] } };
  await bundle.writePage(out, m, "Customer", [raw], true);
  const rows = [];
  for await (const row of bundle.readEntity(out, "Customer", {
    allowIncomplete: true,
  }))
    rows.push(row);
  assert.deepEqual(rows, [raw]);
  await bundle.validateBundle(out, { allowIncomplete: true });
  await writeFile(join(out, m.entities.Customer.pages[0].path), "[]");
  await assert.rejects(
    bundle.validateBundle(out, { allowIncomplete: true }),
    /checksum/,
  );
});
test("rejects duplicate source IDs across pages", async (t) => {
  assert.equal(typeof bundle.writePage, "function");
  const out = join(await temp(t), "export");
  const m = await bundle.createBundle(out, source);
  await bundle.writePage(out, m, "Customer", [{ Id: "7" }], false);
  await bundle.writePage(out, m, "Customer", [{ Id: "7" }], true);
  await assert.rejects(
    bundle.validateBundle(out, { allowIncomplete: true }),
    /duplicate/i,
  );
});
test("rejects path traversal and symlinked bundle components", async (t) => {
  assert.equal(typeof bundle.writePage, "function");
  const root = await temp(t),
    out = join(root, "export");
  const m = await bundle.createBundle(out, source);
  await bundle.writePage(out, m, "Customer", [{ Id: "7" }], true);
  m.entities.Customer.pages[0].path = "../secret.json";
  await storage.atomicJson(join(out, "manifest.json"), m);
  await assert.rejects(
    bundle.validateBundle(out, { allowIncomplete: true }),
    /path/i,
  );
  m.entities.Customer.pages[0].path = "entities/Customer/pages/1.json";
  await storage.atomicJson(join(out, "manifest.json"), m);
  await rm(join(out, "entities/Customer/pages/1.json"));
  await writeFile(join(root, "secret.json"), '[{"Id":"7"}]');
  await symlink(
    join(root, "secret.json"),
    join(out, "entities/Customer/pages/1.json"),
  );
  await assert.rejects(
    bundle.validateBundle(out, { allowIncomplete: true }),
    /symlink/i,
  );
});
test("refuses malformed manifests and missing required coverage", async (t) => {
  assert.equal(typeof bundle.createBundle, "function");
  const out = join(await temp(t), "export");
  const m = await bundle.createBundle(out, source);
  delete m.entities.Invoice;
  await storage.atomicJson(join(out, "manifest.json"), m);
  await assert.rejects(
    bundle.validateBundle(out, { allowIncomplete: true }),
    /coverage/,
  );
  await writeFile(join(out, "manifest.json"), '{"version":99}');
  await assert.rejects(bundle.validateBundle(out), /version|format/);
});
test("serializes writers and recovers locks only for a dead process", async (t) => {
  assert.equal(typeof storage.withLock, "function");
  const lock = join(await temp(t), "writer.lock");
  await storage.withLock(lock, async () => {
    await assert.rejects(
      storage.withLock(lock, async () => {}),
      /locked/,
    );
  });
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({
      pid: 2147483647,
      hostname: (await import("node:os")).hostname(),
    }),
  );
  await storage.withLock(lock, async () =>
    assert.equal(
      JSON.parse(await readFile(join(lock, "owner.json"))).pid,
      process.pid,
    ),
  );
});
