import { ENTITY_SPECS } from "./catalog.js";
import { isQboReport } from "./report-validation.js";
import { isObject, type JsonObject } from "./types.js";
export const QBO_MINOR_VERSION = "75";
export class QboApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly faultCode?: string,
  ) {
    super(message);
    this.name = "QboApiError";
  }
}
export function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s"']+/gi, "[REDACTED]")
    .replace(
      /(?:access_token|refresh_token|client_secret|code|state)\s*[=:]\s*[^&\s,]+/gi,
      "[REDACTED]",
    )
    .replace(
      /"(?:access_token|refresh_token|client_secret|code|state)"\s*:\s*"[^"]*"/gi,
      "[REDACTED]",
    )
    .slice(0, 800);
}
export interface QboClientOptions {
  apiBaseUrl: string;
  realmId: string;
  accessToken: () => Promise<string>;
  refresh: () => Promise<string>;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  attempts?: number;
  timeoutMs?: number;
}
const retryable = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class QboClient {
  constructor(private readonly options: QboClientOptions) {}
  async get(
    resource: string,
    params: Record<string, string> = {},
  ): Promise<JsonObject> {
    const url = new URL(
      `${this.options.apiBaseUrl}/v3/company/${encodeURIComponent(this.options.realmId)}/${resource}`,
    );
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    let refreshed = false;
    const attempts = this.options.attempts ?? 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        const token = await this.options.accessToken();
        response = await (this.options.fetchImpl ?? fetch)(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          redirect: "error",
        });
      } catch {
        if (attempt === attempts - 1)
          throw new QboApiError(
            "QBO request failed or timed out after bounded retries",
            503,
          );
        await sleep((this.options.retryDelayMs ?? 300) * 2 ** attempt);
        continue;
      }
      if (response.status === 401 && !refreshed) {
        await response.body?.cancel();
        refreshed = true;
        await this.options.refresh();
        attempt--;
        continue;
      }
      if (retryable.has(response.status) && attempt < attempts - 1) {
        const header = response.headers.get("retry-after");
        const seconds = header === null ? NaN : Number(header);
        const requested = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(header ?? "") - Date.now();
        await response.body?.cancel();
        await sleep(
          Math.min(
            60_000,
            Math.max(
              0,
              Number.isFinite(requested)
                ? requested
                : (this.options.retryDelayMs ?? 300) * 2 ** attempt,
            ),
          ),
        );
        continue;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new QboApiError(
          `QBO returned invalid JSON (HTTP ${response.status})`,
          response.ok ? 502 : response.status,
        );
      }
      const fault =
        isObject(body) &&
        isObject(body.Fault) &&
        Array.isArray(body.Fault.Error) &&
        isObject(body.Fault.Error[0])
          ? body.Fault.Error[0]
          : undefined;
      // API fault descriptions can echo request values; log only status and code.
      const faultCode =
        fault && typeof fault.code === "string" && /^[\w-]+$/.test(fault.code)
          ? fault.code
          : undefined;
      if (!response.ok || (isObject(body) && body.Fault))
        throw new QboApiError(
          `QBO API fault (HTTP ${response.status}${faultCode ? `, code ${faultCode}` : ""})`,
          response.ok ? 400 : response.status,
          faultCode,
        );
      if (!isObject(body))
        throw new QboApiError("QBO returned a malformed response", 502);
      return body;
    }
    throw new QboApiError("QBO retry limit reached", 503);
  }
  async queryPage(
    entity: string,
    startPosition: number,
    options: { includeInactive?: boolean; pageSize?: number } = {},
  ): Promise<JsonObject[]> {
    if (!ENTITY_SPECS.some((s) => s.entity === entity && !s.single))
      throw new Error("Unknown query entity");
    const size = options.pageSize ?? 1000;
    if (
      !Number.isSafeInteger(startPosition) ||
      startPosition < 1 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 1000
    )
      throw new Error("Invalid pagination");
    const where = options.includeInactive
      ? " WHERE Active IN (true, false)"
      : "";
    const body = await this.get("query", {
      query: `SELECT * FROM ${entity}${where} STARTPOSITION ${startPosition} MAXRESULTS ${size}`,
    });
    if (!isObject(body.QueryResponse))
      throw new QboApiError("QBO returned no QueryResponse", 502);
    const rows = body.QueryResponse[entity];
    const metadata = body.QueryResponse;
    const integer = (v: unknown) =>
      Number.isSafeInteger(v) && (v as number) >= 0;
    if (
      (metadata.startPosition !== undefined &&
        (!integer(metadata.startPosition) ||
          metadata.startPosition !== startPosition)) ||
      (metadata.maxResults !== undefined && !integer(metadata.maxResults)) ||
      (metadata.totalCount !== undefined && !integer(metadata.totalCount))
    )
      throw new QboApiError("QBO returned malformed pagination metadata", 502);
    if (rows === undefined) {
      if (
        (body.QueryResponse.totalCount !== undefined &&
          body.QueryResponse.totalCount !== 0) ||
        (body.QueryResponse.maxResults !== undefined &&
          body.QueryResponse.maxResults !== 0) ||
        Object.keys(body.QueryResponse).some(
          (k) => !["startPosition", "maxResults", "totalCount"].includes(k),
        )
      )
        throw new QboApiError(
          "QBO returned a malformed QueryResponse entity",
          502,
        );
      return [];
    }
    if (!Array.isArray(rows) || rows.length > size || !rows.every(isObject))
      throw new QboApiError("QBO returned malformed query rows", 502);
    if (
      (metadata.maxResults !== undefined &&
        metadata.maxResults !== rows.length) ||
      (metadata.totalCount !== undefined &&
        ((metadata.totalCount as number) < rows.length ||
          (rows.length === 0 &&
            (metadata.totalCount as number) >= startPosition)))
    )
      throw new QboApiError("QBO returned malformed row count metadata", 502);
    return rows;
  }
  private async singleton(resource: string, key: string): Promise<JsonObject> {
    const body = await this.get(resource);
    if (!isObject(body[key]) || !Object.keys(body[key]).length)
      throw new QboApiError(`QBO returned malformed ${key}`, 502);
    return body[key];
  }
  companyInfo(): Promise<JsonObject> {
    return this.singleton(
      `companyinfo/${encodeURIComponent(this.options.realmId)}`,
      "CompanyInfo",
    );
  }
  preferences(): Promise<JsonObject> {
    return this.singleton("preferences", "Preferences");
  }
  async report(
    name: string,
    params: Record<string, string>,
  ): Promise<JsonObject> {
    if (
      ![
        "BalanceSheet",
        "TrialBalance",
        "ProfitAndLoss",
        "GeneralLedger",
        "AgedReceivables",
        "AgedPayables",
      ].includes(name)
    )
      throw new Error("Unknown report");
    const body = await this.get(`reports/${name}`, params);
    if (!isQboReport(body, name))
      throw new QboApiError("QBO returned a malformed report", 502);
    return body;
  }
}
