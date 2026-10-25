import { test } from "node:test";
import assert from "node:assert/strict";
const api = await import("../dist/client.js").catch(() => ({}));
const response = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
function client(fetchImpl, extra = {}) {
  assert.equal(typeof api.QboClient, "function");
  return new api.QboClient({
    apiBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
    realmId: "123",
    accessToken: async () => "secret",
    refresh: async () => "new",
    fetchImpl,
    retryDelayMs: 1,
    ...extra,
  });
}
test("uses paginated inactive query and retains unknown nested fields", async () => {
  let url;
  const c = client(async (u) => {
    url = new URL(u);
    return response({
      QueryResponse: { Customer: [{ Id: "1", Extra: { a: 7 } }] },
    });
  });
  assert.deepEqual(
    await c.queryPage("Customer", 1001, {
      includeInactive: true,
      pageSize: 1000,
    }),
    [{ Id: "1", Extra: { a: 7 } }],
  );
  assert.equal(
    url.searchParams.get("query"),
    "SELECT * FROM Customer WHERE Active IN (true, false) STARTPOSITION 1001 MAXRESULTS 1000",
  );
  assert.equal(url.searchParams.get("minorversion"), "75");
  assert.equal(url.pathname, "/v3/company/123/query");
});
test("refreshes once after 401, never loops, and retries server failures", async () => {
  let calls = 0,
    refreshes = 0;
  const c = client(
    async () => response({}, ++calls <= 2 ? (calls === 1 ? 401 : 503) : 200),
    {
      refresh: async () => {
        refreshes++;
        return "new";
      },
    },
  );
  await c.get("query");
  assert.equal(calls, 3);
  assert.equal(refreshes, 1);
  const fail = client(async () => response({}, 401), {
    refresh: async () => {
      refreshes++;
      return "new";
    },
  });
  await assert.rejects(fail.get("query"), /HTTP 401/);
  assert.equal(refreshes, 2);
});
test("rejects malformed query bodies, faults, and non-JSON success", async () => {
  for (const body of [
    {},
    { QueryResponse: { Customer: {} } },
    { QueryResponse: { Customer: [null] } },
    { Fault: { Error: [{ code: "4000", Detail: "broken" }] } },
  ]) {
    await assert.rejects(
      client(async () => response(body)).queryPage("Customer", 1),
      /malformed|fault|QueryResponse/i,
    );
  }
  await assert.rejects(
    client(async () => new Response("bad")).get("query"),
    /JSON/,
  );
  assert.deepEqual(
    await client(async () => response({ QueryResponse: {} })).queryPage(
      "Customer",
      1,
    ),
    [],
  );
});
test("bounds network retries and redacts credentials from error messages", async () => {
  let calls = 0;
  const c = client(
    async () => {
      calls++;
      throw new Error("Bearer private access_token=leak");
    },
    { attempts: 2 },
  );
  await assert.rejects(
    c.get("query"),
    (e) => !e.message.includes("private") && !e.message.includes("leak"),
  );
  assert.equal(calls, 2);
  assert.equal(
    api
      .sanitizeError(
        new Error("code=oauth-secret&refresh_token=refresh-secret"),
      )
      .includes("secret"),
    false,
  );
});
test("rejects query injection, unknown resources, and malformed reports", async () => {
  const c = client(async () => response({}));
  await assert.rejects(c.queryPage("Customer WHERE Id=1", 1), /entity/i);
  await assert.rejects(c.report("BalanceSheet", {}), /report/i);
});

test("rejects a claimed nonempty query response with missing entity rows", async () => {
  await assert.rejects(
    client(async () =>
      response({ QueryResponse: { totalCount: 3 } }),
    ).queryPage("Customer", 1),
    /malformed/i,
  );
});

test("request timeout fails within a bounded interval instead of hanging", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const c = new api.QboClient({
      apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
      realmId: "123",
      accessToken: async () => "test",
      refresh: async () => "test",
      timeoutMs: 20,
      attempts: 1,
    });
    await assert.rejects(c.get("query"), /timed out/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects shallow/mismatched reconciliation reports while accepting a structured empty report", async () => {
  await assert.rejects(
    client(async () => response({ Header: {}, Columns: {}, Rows: {} })).report(
      "BalanceSheet",
      {},
    ),
    /malformed report/,
  );
  await assert.rejects(
    client(async () =>
      response({
        Header: { ReportName: "ProfitAndLoss" },
        Columns: { Column: [] },
        Rows: {},
      }),
    ).report("BalanceSheet", {}),
    /malformed report/,
  );
  assert.deepEqual(
    await client(async () =>
      response({
        Header: { ReportName: "BalanceSheet" },
        Columns: { Column: [] },
        Rows: {},
      }),
    ).report("BalanceSheet", {}),
    {
      Header: { ReportName: "BalanceSheet" },
      Columns: { Column: [] },
      Rows: {},
    },
  );
});

test("checks pagination metadata against actual rows and requested position", async () => {
  for (const QueryResponse of [
    { Customer: [], maxResults: 1 },
    { Customer: [{ Id: "1" }], maxResults: 2 },
    { Customer: [{ Id: "1" }], startPosition: 2 },
    { Customer: [{ Id: "1" }], totalCount: 0 },
    { Customer: [{ Id: "1" }], maxResults: "1" },
  ])
    await assert.rejects(
      client(async () => response({ QueryResponse })).queryPage("Customer", 1),
      /malformed/i,
    );
});
