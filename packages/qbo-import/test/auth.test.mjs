import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const auth = await import("../dist/auth.js").catch(() => ({}));
const configuration = await import("../dist/config.js").catch(() => ({}));
const json = (b) => new Response(JSON.stringify(b), { status: 200 });
async function setup(t, overrides = {}) {
  assert.equal(typeof auth.ConnectionStore, "function");
  const stateDir = await mkdtemp(join(tmpdir(), "lega-qbo-auth-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = {
    environment: "sandbox",
    clientId: "client",
    clientSecret: "client-secret",
    tokenKey: Buffer.alloc(32, 1),
    redirectUri: "http://localhost:9477/callback",
    stateDir,
    apiBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    ...overrides,
  };
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("tokens/bearer")) {
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        return json({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          expires_in: 3600,
        });
      }
      assert.equal(form.get("code"), "authorization-code");
      return json({
        access_token: "access-private",
        refresh_token: "refresh-private",
        expires_in: 3600,
      });
    }
    if (String(url).includes("companyinfo"))
      return json({ CompanyInfo: { CompanyName: "Test Books", Id: "123" } });
    if (String(url).includes("preferences"))
      return json({
        Preferences: { CurrencyPrefs: { HomeCurrency: { value: "LKR" } } },
      });
    return json({});
  };
  const store = new auth.ConnectionStore(config, fetchImpl);
  return { store, config, refreshes: () => refreshes };
}
function callback(url, state, realmId = "123") {
  return `http://localhost:9477/callback?code=authorization-code&state=${state ?? new URL(url).searchParams.get("state")}&realmId=${realmId}`;
}
test("validates OAuth state, retains pending login on invalid callback, and rejects replay", async (t) => {
  const { store } = await setup(t);
  const { url } = await store.begin();
  await assert.rejects(store.complete(callback(url, "bad")), /state/i);
  await assert.rejects(
    store.complete(callback(url).replace("localhost", "evil.example")),
    /redirect/i,
  );
  const saved = await store.complete(callback(url));
  assert.equal(saved.realmId, "123");
  assert.equal(saved.companyName, "Test Books");
  await assert.rejects(store.complete(callback(url)), /pending|used/i);
});
test("expires authorization and encrypts tokens with private permissions", async (t) => {
  const { store, config } = await setup(t);
  const pending = await store.begin();
  await assert.rejects(
    store.complete(callback(pending.url), Date.now() + 11 * 60_000),
    /expired/i,
  );
  const second = await store.begin();
  await store.complete(callback(second.url));
  const raw = await readFile(join(config.stateDir, "connection.json"), "utf8");
  assert.equal(raw.includes("access-private"), false);
  assert.equal(raw.includes("refresh-private"), false);
  assert.equal(
    (await stat(join(config.stateDir, "connection.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await store.status()).homeCurrency, "LKR");
  const wrong = new auth.ConnectionStore({
    ...config,
    tokenKey: Buffer.alloc(32, 2),
  });
  await assert.rejects(wrong.status(), /decrypt|key/i);
});
test("serializes refresh rotation and pins clients to environment and realm", async (t) => {
  const { store, refreshes } = await setup(t);
  await store.complete(callback((await store.begin()).url));
  const conn = await store.status();
  await assert.rejects(
    store.client({
      realmId: "999",
      environment: "sandbox",
      minorVersion: "75",
    }),
    /realm/i,
  );
  const [a, b] = await Promise.all([
    store.refresh("access-private"),
    store.refresh("access-private"),
  ]);
  assert.equal(a, "access-rotated");
  assert.equal(b, "access-rotated");
  assert.equal(refreshes(), 1);
  assert.equal(conn.environment, "sandbox");
  await store.disconnect();
  assert.equal(await store.status(), null);
});
test("production config rejects insecure redirect and validates key without exposing values", () => {
  assert.equal(typeof configuration.configFromEnv, "function");
  const env = {
    QBO_CLIENT_ID: "a",
    QBO_CLIENT_SECRET: "s",
    QBO_ENVIRONMENT: "production",
    QBO_TOKEN_KEY: Buffer.alloc(32).toString("base64"),
    QBO_REDIRECT_URI: "http://localhost:9477/callback",
  };
  assert.throws(
    () => configuration.configFromEnv(env, "/tmp"),
    /HTTPS|production/,
  );
  assert.throws(
    () =>
      configuration.configFromEnv(
        {
          ...env,
          QBO_REDIRECT_URI: "https://example.com/callback",
          QBO_TOKEN_KEY: "TOP-SECRET",
        },
        "/tmp",
      ),
    (e) => /QBO_TOKEN_KEY/.test(e.message) && !e.message.includes("TOP-SECRET"),
  );
});

test("browser loopback callback survives invalid state and closes after valid sign-in", async (t) => {
  const login = await import("../dist/prompt.js").catch(() => ({}));
  assert.equal(typeof login.connectBrowser, "function");
  const { createServer } = await import("node:http");
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const { store, config } = await setup(t, {
    redirectUri: `http://127.0.0.1:${port}/callback`,
  });
  await login.connectBrowser(store, {
    timeoutMs: 3000,
    log: () => {},
    openBrowser: async (url) => {
      const state = new URL(url).searchParams.get("state");
      const invalid = await fetch(
        `${config.redirectUri}?state=bad&code=authorization-code&realmId=123`,
      );
      assert.equal(invalid.status, 400);
      const valid = await fetch(
        `${config.redirectUri}?state=${state}&code=authorization-code&realmId=123`,
      );
      assert.equal(valid.status, 200);
      assert.equal((await valid.text()).includes("authorization-code"), false);
    },
  });
  assert.equal((await store.status()).realmId, "123");
  await assert.rejects(fetch(config.redirectUri));
});
test("manual production sign-in exchanges a pasted callback without echoing it", async (t) => {
  const login = await import("../dist/prompt.js").catch(() => ({}));
  assert.equal(typeof login.connectBrowser, "function");
  const { store } = await setup(t, {
    environment: "production",
    redirectUri: "https://return.example/callback",
  });
  let url,
    output = "";
  await login.connectBrowser(store, {
    log: (text) => {
      output += text;
    },
    openBrowser: async (value) => {
      url = value;
    },
    manualInput: async () =>
      `https://return.example/callback?code=authorization-code&state=${new URL(url).searchParams.get("state")}&realmId=123`,
  });
  assert.equal((await store.status()).environment, "production");
  assert.equal(output.includes("authorization-code"), false);
});

test("browser denial closes listener and releases sign-in lock immediately", async (t) => {
  const login = await import("../dist/prompt.js");
  const { createServer } = await import("node:http");
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const { store, config } = await setup(t, {
    redirectUri: `http://127.0.0.1:${port}/callback`,
  });
  await assert.rejects(
    login.connectBrowser(store, {
      timeoutMs: 300,
      log: () => {},
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`${config.redirectUri}?state=${state}&error=access_denied`);
      },
    }),
    /declined/,
  );
  await assert.rejects(fetch(config.redirectUri));
});
