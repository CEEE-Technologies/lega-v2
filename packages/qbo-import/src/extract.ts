import { mkdir, readFile, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  QboClient,
  QboApiError,
  QBO_MINOR_VERSION,
  sanitizeError,
} from "./client.js";
import { ENTITY_SPECS, sourceId } from "./catalog.js";
import {
  bundlePath,
  createBundle,
  hash,
  saveManifest,
  validateBundle,
  writePage,
} from "./bundle.js";
import { atomicJson, withLock } from "./storage.js";
import { fiscalMonth, isDate, planReports, today } from "./reports.js";
import {
  isObject,
  type JsonObject,
  type Manifest,
  type Source,
} from "./types.js";

export interface ExtractOptions {
  out: string;
  client: QboClient;
  source: Source;
  resume?: boolean;
  pageSize?: number;
  reportDate?: string;
  onProgress?: (message: string) => void;
}
export async function reportContext(
  out: string,
  m: Manifest,
): Promise<{
  company: JsonObject;
  preferences: JsonObject;
  accounts: JsonObject[];
  first?: string;
  last?: string;
}> {
  let company: JsonObject = {},
    preferences: JsonObject = {},
    first: string | undefined,
    last: string | undefined;
  const accounts: JsonObject[] = [];
  for (const spec of ENTITY_SPECS)
    for (const page of m.entities[spec.entity].pages) {
      const rows: JsonObject[] = JSON.parse(
        await readFile(await bundlePath(out, page.path), "utf8"),
      );
      if (spec.entity === "CompanyInfo") company = rows[0] ?? {};
      if (spec.entity === "Preferences") preferences = rows[0] ?? {};
      if (spec.entity === "Account") accounts.push(...rows);
      for (const row of rows)
        if (isDate(row.TxnDate)) {
          if (!first || row.TxnDate < first) first = row.TxnDate;
          if (!last || row.TxnDate > last) last = row.TxnDate;
        }
    }
  return { company, preferences, accounts, first, last };
}
export function inventoryLedgerAccounts(accounts: JsonObject[]): string[] {
  if (!accounts.some((a) => a.AccountSubType === "Inventory")) return [];
  return accounts
    .filter(
      (a) =>
        a.AccountSubType === "Inventory" ||
        a.AccountType === "Cost of Goods Sold" ||
        a.AccountSubType === "OpeningBalanceEquity",
    )
    .map((a) => String(a.Id));
}
export function reportId(name: string, params: Record<string, string>): string {
  return hash(
    JSON.stringify([
      name,
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}
export async function extractBundle(
  options: ExtractOptions,
): Promise<Manifest> {
  const { client, source } = options,
    out = resolve(options.out);
  if (
    !/^\d{1,40}$/.test(source.realmId) ||
    !["sandbox", "production"].includes(source.environment) ||
    source.minorVersion !== QBO_MINOR_VERSION
  )
    throw new Error("Invalid QBO source");
  if (options.reportDate !== undefined && !isDate(options.reportDate))
    throw new Error("Invalid report date; use YYYY-MM-DD");
  if (
    options.pageSize !== undefined &&
    (!Number.isInteger(options.pageSize) ||
      options.pageSize < 1 ||
      options.pageSize > 1000)
  )
    throw new Error("Page size must be 1 to 1000");
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(out)).isSymbolicLink())
      throw new Error(
        "Output directory must not be a symlink; use the original bundle path",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return withLock(`${out}.lock`, async () => {
    const m = options.resume
      ? await validateBundle(out, { allowIncomplete: true })
      : await createBundle(out, source, options);
    if (
      m.source.realmId !== source.realmId ||
      m.source.environment !== source.environment ||
      m.source.minorVersion !== source.minorVersion
    )
      throw new Error("Bundle realm/environment/API version mismatch");
    if (
      (options.pageSize !== undefined && m.pageSize !== options.pageSize) ||
      (options.reportDate !== undefined && m.reportDate !== options.reportDate)
    )
      throw new Error(
        "Resume configuration mismatch; omit page-size/report-date to use saved settings",
      );
    if (m.status === "complete") return m;
    m.status = "extracting";
    delete m.error;
    await saveManifest(out, m);
    const warn = (message: string) => {
      if (!m.warnings.includes(message)) m.warnings.push(message);
      options.onProgress?.(`Warning: ${message}`);
    };
    try {
      for (const spec of ENTITY_SPECS) {
        const s = m.entities[spec.entity];
        if (s.status === "done" || s.status === "unavailable") continue;
        if (spec.single) {
          const row =
            spec.single === "companyinfo"
              ? await client.companyInfo()
              : await client.preferences();
          await writePage(out, m, spec.entity, [row], true);
        } else
          for (;;) {
            let rows: JsonObject[];
            try {
              rows = await client.queryPage(spec.entity, s.nextPosition, {
                includeInactive: s.includeInactive,
                pageSize: m.pageSize,
              });
            } catch (error) {
              // A QBO query-validation fault is distinct from generic 400 (which
              // could mean a malformed/expired request and must not hide data).
              if (
                error instanceof QboApiError &&
                error.status === 400 &&
                error.faultCode === "4000" &&
                s.includeInactive
              ) {
                s.includeInactive = false;
                warn(
                  `${spec.entity}: inactive filter unsupported; only default active records may be returned`,
                );
                await saveManifest(out, m);
                continue;
              }
              if (
                spec.optional &&
                s.count === 0 &&
                error instanceof QboApiError &&
                (error.status === 403 ||
                  (error.status === 400 &&
                    ["4000", "500", "501"].includes(error.faultCode ?? "")))
              ) {
                s.status = "unavailable";
                s.reason = `QBO resource unavailable (HTTP ${error.status}${error.faultCode ? `, code ${error.faultCode}` : ""})`;
                warn(`${spec.entity}: ${s.reason}`);
                await saveManifest(out, m);
                break;
              }
              throw error;
            }
            for (const row of rows) sourceId(spec.entity, row);
            const done = rows.length < m.pageSize;
            await writePage(out, m, spec.entity, rows, done);
            options.onProgress?.(
              `${spec.entity}: ${s.count} records${done ? " (done)" : ""}`,
            );
            if (done) break;
          }
        options.onProgress?.(`${spec.entity}: ${s.count} records, ${s.status}`);
      }
      if (!m.reportsPlanned) {
        const context = await reportContext(out, m),
          date = today();
        m.reportDate ??=
          context.last && context.last > date ? context.last : date;
        m.firstTxnDate = context.first;
        m.fiscalYearStartMonth = fiscalMonth(
          context.company.FiscalYearStartMonth,
        );
        if (
          typeof context.company.FiscalYearStartMonth !== "string" ||
          !/^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
            context.company.FiscalYearStartMonth,
          )
        )
          warn(
            "Fiscal year start month unavailable; using January for reports",
          );
        if (context.last && context.last > m.reportDate)
          warn(
            "Report date precedes some extracted transactions; entities include the full available history",
          );
        m.companyName = String(
          context.company.CompanyName ??
            context.company.LegalName ??
            "QuickBooks company",
        );
        const currencyPrefs = isObject(context.preferences.CurrencyPrefs)
          ? context.preferences.CurrencyPrefs
          : {};
        const currency = isObject(currencyPrefs.HomeCurrency)
          ? currencyPrefs.HomeCurrency.value
          : undefined;
        if (typeof currency === "string") m.homeCurrency = currency;
        else warn("QBO home currency unavailable in Preferences");
        m.reports = planReports({
          firstTxnDate: context.first,
          cutOverDate: m.reportDate,
          fiscalYearStartMonth: m.fiscalYearStartMonth,
          inventoryAccountIds: inventoryLedgerAccounts(context.accounts),
        }).map((r) => ({ ...r, id: reportId(r.name, r.params) }));
        m.reportsPlanned = true;
        await saveManifest(out, m);
      }
      for (const report of m.reports) {
        if (report.file) continue;
        const data = await client.report(report.name, report.params),
          path = `reports/${report.id}.json`;
        const file = await bundlePath(out, path);
        await atomicJson(file, data);
        report.file = { path, count: 1, sha256: hash(await readFile(file)) };
        await saveManifest(out, m);
        options.onProgress?.(`Report ${report.name}: saved`);
      }
      // Validate before advertising completion, including cross-page source IDs.
      await validateBundle(out, { allowIncomplete: true });
      m.status = "complete";
      m.completedAt = new Date().toISOString();
      await saveManifest(out, m);
      return await validateBundle(out);
    } catch (error) {
      m.status = "failed";
      m.error = sanitizeError(error);
      delete m.completedAt;
      await saveManifest(out, m);
      throw error;
    }
  });
}
