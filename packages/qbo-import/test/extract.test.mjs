import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QboClient } from "../dist/client.js";
import { validateBundle, loadManifest, readEntity } from "../dist/bundle.js";
const extraction = await import("../dist/extract.js").catch(() => ({}));
const source = { realmId: "123", environment: "sandbox", minorVersion: "75" };
async function fixture(t) {
  assert.equal(typeof extraction.extractBundle, "function");
  const root = await mkdtemp(join(tmpdir(), "lega-qbo-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = {
    failCustomer: false,
    failReport: false,
    requiredFailure: false,
    malformed: false,
    requests: [],
  };
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    state.requests.push(u.pathname + u.search);
    res.setHeader("Content-Type", "application/json");
    if (u.pathname.includes("companyinfo"))
      return res.end(
        JSON.stringify({
          CompanyInfo: {
            Id: "123",
            CompanyName: "Synthetic Books",
            FiscalYearStartMonth: "April",
          },
        }),
      );
    if (u.pathname.endsWith("/preferences"))
      return res.end(
        JSON.stringify({
          Preferences: { CurrencyPrefs: { HomeCurrency: { value: "LKR" } } },
        }),
      );
    if (u.pathname.includes("/reports/")) {
      if (state.failReport) {
        res.statusCode = 503;
        return res.end("{}");
      }
      return res.end(
        JSON.stringify({
          Header: { ReportName: u.pathname.split("/").pop() },
          Columns: { Column: [] },
          Rows: { Row: [] },
        }),
      );
    }
    const query = u.searchParams.get("query");
    const entity = /FROM (\w+)/.exec(query)[1],
      position = Number(/STARTPOSITION (\d+)/.exec(query)[1]);
    if (
      entity === "Class" ||
      (entity === "Customer" && state.requiredFailure)
    ) {
      res.statusCode = 403;
      return res.end(
        JSON.stringify({
          Fault: { Error: [{ code: "120", Detail: "forbidden" }] },
        }),
      );
    }
    if (entity === "Customer" && state.failCustomer && position === 3) {
      res.statusCode = 503;
      return res.end("{}");
    }
    const data = {
      Customer: [
        { Id: "1", Extra: { nested: true } },
        { Id: "2" },
        { Id: "3" },
      ],
      Invoice: [
        {
          Id: "9",
          TxnDate: "2024-04-01",
          CustomerRef: { value: "1" },
          Line: [{ Amount: 12.34 }],
        },
      ],
      Account: [
        { Id: "8", AccountSubType: "Inventory" },
        { Id: "2", AccountType: "Cost of Goods Sold" },
      ],
    };
    return res.end(
      JSON.stringify(
        state.malformed && entity === "Customer"
          ? {}
          : {
              QueryResponse: {
                [entity]: (data[entity] ?? []).slice(
                  position - 1,
                  position + 1,
                ),
              },
            },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const client = new QboClient({
    apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
    realmId: "123",
    accessToken: async () => "fake",
    refresh: async () => "fake",
    attempts: 1,
  });
  return { out: join(root, "export"), state, client };
}
test("extracts raw multipage entities and fiscal reports without lega-v2 services", async (t) => {
  const f = await fixture(t);
  const m = await extraction.extractBundle({
    ...f,
    source,
    pageSize: 2,
    reportDate: "2024-05-01",
  });
  assert.equal(m.status, "complete");
  assert.equal(m.entities.Customer.count, 3);
  assert.equal(m.homeCurrency, "LKR");
  assert.equal(m.entities.Class.status, "unavailable");
  assert.ok(m.warnings.some((w) => w.includes("Class")));
  assert.equal(m.reports.length, 6);
  assert.equal((await validateBundle(f.out)).status, "complete");
  const rows = [];
  for await (const row of readEntity(f.out, "Customer")) rows.push(row);
  assert.deepEqual(rows[0], { Id: "1", Extra: { nested: true } });
  // An importer must not accept a fabricated complete bundle missing its P&L.
  m.reports.splice(2, 1);
  await writeFile(join(f.out, "manifest.json"), JSON.stringify(m));
  await assert.rejects(validateBundle(f.out), /report.*plan|coverage/i);
});
test("resumes failed page, replacing an uncommitted file without duplicating records", async (t) => {
  const f = await fixture(t);
  f.state.failCustomer = true;
  await assert.rejects(
    extraction.extractBundle({
      ...f,
      source,
      pageSize: 2,
      reportDate: "2024-05-01",
    }),
    /503/,
  );
  assert.equal((await loadManifest(f.out)).entities.Customer.count, 2);
  await writeFile(
    join(f.out, "entities/Customer/pages/3.json"),
    '[{"Id":"orphan"}]',
  );
  f.state.failCustomer = false;
  f.state.requests = [];
  const m = await extraction.extractBundle({ ...f, source, resume: true });
  assert.equal(m.entities.Customer.count, 3);
  assert.equal(
    f.state.requests.some((r) => r.includes("companyinfo")),
    false,
  );
  assert.equal((await validateBundle(f.out)).status, "complete");
  await assert.rejects(
    extraction.extractBundle({
      ...f,
      source: { ...source, realmId: "999" },
      resume: true,
    }),
    /realm|mismatch/i,
  );
});
test("required permissions and malformed responses stop extraction rather than becoming empty", async (t) => {
  const f = await fixture(t);
  f.state.requiredFailure = true;
  await assert.rejects(
    extraction.extractBundle({ ...f, source, pageSize: 2 }),
    /403/,
  );
  assert.equal((await loadManifest(f.out)).entities.Customer.status, "pending");
  f.state.requiredFailure = false;
  f.state.malformed = true;
  await assert.rejects(
    extraction.extractBundle({ ...f, source, resume: true }),
    /QueryResponse/,
  );
  await assert.rejects(validateBundle(f.out), /incomplete/);
});
test("resumes required report failures without rereading completed entities", async (t) => {
  const f = await fixture(t);
  f.state.failReport = true;
  await assert.rejects(
    extraction.extractBundle({
      ...f,
      source,
      pageSize: 2,
      reportDate: "2024-05-01",
    }),
    /503/,
  );
  f.state.failReport = false;
  f.state.requests = [];
  await extraction.extractBundle({ ...f, source, resume: true });
  assert.equal(
    f.state.requests.every((r) => r.includes("/reports/")),
    true,
  );
  assert.equal((await validateBundle(f.out)).reports.length, 6);
});

test("rejects symlinked output roots so aliases cannot bypass the writer lock", async (t) => {
  const f = await fixture(t);
  await extraction.extractBundle({
    ...f,
    source,
    pageSize: 2,
    reportDate: "2024-05-01",
  });
  const { symlink } = await import("node:fs/promises");
  const { withLock } = await import("../dist/storage.js");
  const alias = `${f.out}-alias`;
  await symlink(f.out, alias);
  await withLock(`${f.out}.lock`, async () => {
    await assert.rejects(
      extraction.extractBundle({ ...f, out: alias, source, resume: true }),
      /symlink|locked/i,
    );
  });
});

test("parent-directory symlink aliases share the same physical writer lock", async (t) => {
  const f = await fixture(t);
  await extraction.extractBundle({
    ...f,
    source,
    pageSize: 2,
    reportDate: "2024-05-01",
  });
  const { symlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { withLock } = await import("../dist/storage.js");
  const aliasParent = join(dirname(f.out), "parent-alias");
  await symlink(dirname(f.out), aliasParent);
  await withLock(`${f.out}.lock`, async () => {
    await assert.rejects(
      extraction.extractBundle({
        ...f,
        out: join(aliasParent, "export"),
        source,
        resume: true,
      }),
      /locked/i,
    );
  });
});
