import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { join } from "node:path";
import { rm, mkdir, lstat } from "node:fs/promises";
import { atomicJson, jsonFile, withLock } from "./storage.js";
import { QboClient, QBO_MINOR_VERSION, sanitizeError } from "./client.js";
import { isObject, type Environment, type Source } from "./types.js";
import type { Config } from "./config.js";

interface Connection {
  realmId: string;
  environment: Environment;
  companyName: string;
  homeCurrency?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt?: number;
}
interface Pending {
  stateHash: string;
  expiresAt: number;
  redirectUri: string;
  environment: Environment;
  clientId: string;
}
const digest = (s: string) => createHash("sha256").update(s).digest();
export class OAuthTerminalError extends Error {}
export class ConnectionStore {
  constructor(
    readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private get file() {
    return join(this.config.stateDir, "connection.json");
  }
  private get pending() {
    return join(this.config.stateDir, "pending.json");
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.config.stateDir)).isSymbolicLink())
      throw new Error("QBO state directory must not be a symlink");
    return withLock(
      join(this.config.stateDir, "connection.lock"),
      work,
      35_000,
    );
  }
  private aad(): Buffer {
    return Buffer.from(
      `lega-qbo-v1:${this.config.environment}:${this.config.clientId}`,
    );
  }
  private async save(conn: Connection): Promise<void> {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.config.tokenKey, iv);
    cipher.setAAD(this.aad());
    const data = Buffer.concat([
      cipher.update(JSON.stringify(conn)),
      cipher.final(),
    ]);
    await atomicJson(this.file, {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  private async read(): Promise<Connection | null> {
    let envelope: unknown;
    try {
      if ((await lstat(this.file)).isSymbolicLink())
        throw new Error("Invalid connection file");
      envelope = await jsonFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Cannot read encrypted QBO connection file");
    }
    try {
      if (!isObject(envelope) || envelope.version !== 1) throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.config.tokenKey,
        Buffer.from(String(envelope.iv), "base64"),
      );
      decipher.setAAD(this.aad());
      decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
      const conn: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(String(envelope.data), "base64")),
          decipher.final(),
        ]).toString(),
      );
      if (
        !isObject(conn) ||
        !/^\d+$/.test(String(conn.realmId)) ||
        conn.environment !== this.config.environment ||
        typeof conn.accessToken !== "string" ||
        typeof conn.refreshToken !== "string" ||
        typeof conn.accessExpiresAt !== "number" ||
        typeof conn.companyName !== "string"
      )
        throw new Error();
      return conn as unknown as Connection;
    } catch {
      throw new Error(
        "Cannot decrypt QBO connection; check QBO_TOKEN_KEY, client ID and environment",
      );
    }
  }
  async status(): Promise<Omit<
    Connection,
    "accessToken" | "refreshToken"
  > | null> {
    return this.locked(async () => {
      const conn = await this.read();
      if (!conn) return null;
      const { accessToken, refreshToken, ...summary } = conn;
      return summary;
    });
  }
  async begin(): Promise<{ url: string; expiresAt: number }> {
    return this.locked(async () => {
      const state = randomBytes(32).toString("hex"),
        expiresAt = Date.now() + 600_000;
      await atomicJson(this.pending, {
        stateHash: digest(state).toString("hex"),
        expiresAt,
        redirectUri: this.config.redirectUri,
        environment: this.config.environment,
        clientId: this.config.clientId,
      });
      const url = new URL(this.config.authorizeUrl);
      for (const [k, v] of Object.entries({
        client_id: this.config.clientId,
        response_type: "code",
        scope: "com.intuit.quickbooks.accounting",
        redirect_uri: this.config.redirectUri,
        state,
      }))
        url.searchParams.set(k, v);
      return { url: url.toString(), expiresAt };
    });
  }
  private async tokenRequest(form: Record<string, string>): Promise<{
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
    refreshExpiresAt?: number;
  }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        "QBO token endpoint could not be reached; reconnect if authorization failed",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (
      !response.ok ||
      !isObject(body) ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.refresh_token !== "string" ||
      !body.refresh_token ||
      typeof body.expires_in !== "number" ||
      body.expires_in <= 0
    )
      throw new Error(
        `QBO token exchange failed (HTTP ${response.status}); reconnect or check app credentials`,
      );
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: Date.now() + body.expires_in * 1000,
      ...(typeof body.x_refresh_token_expires_in === "number"
        ? {
            refreshExpiresAt:
              Date.now() + body.x_refresh_token_expires_in * 1000,
          }
        : {}),
    };
  }
  async complete(
    callbackUrl: string,
    now = Date.now(),
  ): Promise<Omit<Connection, "accessToken" | "refreshToken">> {
    let consumed = false;
    try {
      await this.locked(async () => {
        let pending: Pending;
        try {
          pending = (await jsonFile(this.pending)) as Pending;
        } catch {
          throw new Error(
            "No pending authorization, or it was already used; connect again",
          );
        }
        if (pending.expiresAt <= now)
          throw new Error("OAuth authorization expired; connect again");
        let callback: URL;
        try {
          callback = new URL(callbackUrl);
        } catch {
          throw new Error("Invalid callback URL");
        }
        const redirect = new URL(this.config.redirectUri);
        if (
          callback.origin !== redirect.origin ||
          callback.pathname !== redirect.pathname ||
          callback.hash ||
          callback.username ||
          callback.password ||
          pending.redirectUri !== this.config.redirectUri ||
          pending.environment !== this.config.environment ||
          pending.clientId !== this.config.clientId
        )
          throw new Error(
            "OAuth redirect does not match configured connection",
          );
        const state = callback.searchParams.get("state") ?? "";
        if (
          callback.searchParams.getAll("state").length !== 1 ||
          !/^[a-f0-9]{64}$/.test(pending.stateHash) ||
          !timingSafeEqual(digest(state), Buffer.from(pending.stateHash, "hex"))
        )
          throw new Error("Invalid OAuth state");
        if (callback.searchParams.has("error")) {
          await rm(this.pending, { force: true });
          throw new OAuthTerminalError(
            "QBO authorization was declined; connect again",
          );
        }
        const realmId = callback.searchParams.get("realmId") ?? "",
          code = callback.searchParams.get("code");
        if (
          !/^\d{1,40}$/.test(realmId) ||
          !code ||
          code.length > 2000 ||
          callback.searchParams.getAll("code").length !== 1 ||
          callback.searchParams.getAll("realmId").length !== 1
        )
          throw new Error("Invalid authorization code or realm");
        await rm(this.pending); // Consume a valid state before exchanging the code.
        consumed = true;
        const tokens = await this.tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.config.redirectUri,
        });
        const client = new QboClient({
          apiBaseUrl: this.config.apiBaseUrl,
          realmId,
          accessToken: async () => tokens.accessToken,
          refresh: async () => {
            throw new Error("New QBO authorization was refused; connect again");
          },
          fetchImpl: this.fetchImpl,
        });
        const info = await client.companyInfo(),
          preferences = await client.preferences();
        const prefs = isObject(preferences.CurrencyPrefs)
          ? preferences.CurrencyPrefs
          : {};
        const currency = isObject(prefs.HomeCurrency)
          ? prefs.HomeCurrency.value
          : undefined;
        await this.save({
          ...tokens,
          realmId,
          environment: this.config.environment,
          companyName: String(
            info.CompanyName ?? info.LegalName ?? "QuickBooks company",
          ),
          ...(typeof currency === "string" ? { homeCurrency: currency } : {}),
        });
      });
    } catch (error) {
      if (consumed) throw new OAuthTerminalError(sanitizeError(error));
      throw error;
    }
    return (await this.status())!;
  }
  private async refreshInside(conn: Connection): Promise<string> {
    if (conn.refreshExpiresAt && conn.refreshExpiresAt <= Date.now())
      throw new Error("QBO refresh token expired; connect again");
    const tokens = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
    });
    await this.save({ ...conn, ...tokens }); // Persist rotation before releasing lock.
    return tokens.accessToken;
  }
  async refresh(seenToken?: string): Promise<string> {
    return this.locked(async () => {
      const conn = await this.read();
      if (!conn) throw new Error("QBO is disconnected; connect first");
      if (
        seenToken &&
        conn.accessToken !== seenToken &&
        conn.accessExpiresAt > Date.now()
      )
        return conn.accessToken;
      return this.refreshInside(conn);
    });
  }
  async client(source?: Source): Promise<QboClient> {
    const connection = await this.status();
    if (!connection) throw new Error("QBO is disconnected; connect first");
    if (
      source &&
      (source.realmId !== connection.realmId ||
        source.environment !== connection.environment ||
        source.minorVersion !== QBO_MINOR_VERSION)
    )
      throw new Error(
        "Bundle realm/environment/API version mismatch; reconnect to its QBO company",
      );
    let seen = "";
    return new QboClient({
      apiBaseUrl: this.config.apiBaseUrl,
      realmId: connection.realmId,
      fetchImpl: this.fetchImpl,
      accessToken: () =>
        this.locked(async () => {
          const conn = await this.read();
          if (!conn) throw new Error("QBO is disconnected; connect first");
          if (conn.realmId !== connection.realmId)
            throw new Error("QBO realm changed during extraction");
          seen =
            conn.accessExpiresAt - 60_000 > Date.now()
              ? conn.accessToken
              : await this.refreshInside(conn);
          return seen;
        }),
      refresh: () => this.refresh(seen),
    });
  }
  async disconnect(): Promise<void> {
    await this.locked(async () => {
      const conn = await this.read();
      if (conn) {
        let ok = false;
        try {
          const response = await this.fetchImpl(this.config.revokeUrl, {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ token: conn.refreshToken }),
            signal: AbortSignal.timeout(30_000),
            redirect: "error",
          });
          ok = response.ok;
          await response.body?.cancel();
        } catch {
          /* Still remove local credentials. */
        }
        await rm(this.file, { force: true });
        await rm(this.pending, { force: true });
        if (!ok)
          throw new Error(
            "Local credentials removed; QBO revocation could not be confirmed. Revoke the app from QuickBooks if needed.",
          );
      } else await rm(this.pending, { force: true });
    });
  }
}
