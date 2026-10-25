import { mkdir, lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicJson, jsonFile } from "./storage.js";
import { ENTITY_SPECS, sourceId } from "./catalog.js";
import {
  isObject,
  type Manifest,
  type Source,
  type Page,
  type JsonObject,
} from "./types.js";
import { fiscalMonth, isDate, planReports } from "./reports.js";
import { isQboReport } from "./report-validation.js";

export const hash = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");
export async function bundlePath(out: string, path: string): Promise<string> {
  if (
    !path ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.startsWith("/")
  )
    throw new Error("Unsafe bundle path");
  const root = await realpath(out),
    target = resolve(root, path);
  if (relative(root, target).startsWith(".." + sep) || target === root)
    throw new Error("Unsafe bundle path");
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("Symlink in bundle path");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export async function saveManifest(out: string, m: Manifest): Promise<void> {
  m.updatedAt = new Date().toISOString();
  await atomicJson(await bundlePath(out, "manifest.json"), m);
}
export async function createBundle(
  out: string,
  source: Source,
  options: { pageSize?: number; reportDate?: string } = {},
): Promise<Manifest> {
  try {
    await mkdir(out, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Output directory exists; use resume or a new directory");
    throw e;
  }
  const now = new Date().toISOString();
  const m: Manifest = {
    format: "lega-qbo-bundle",
    version: 1,
    runId: randomUUID(),
    source,
    startedAt: now,
    updatedAt: now,
    status: "extracting",
    pageSize: options.pageSize ?? 1000,
    ...(options.reportDate ? { reportDate: options.reportDate } : {}),
    reportsPlanned: false,
    entities: Object.fromEntries(
      ENTITY_SPECS.map((s) => [
        s.entity,
        {
          status: "pending",
          nextPosition: 1,
          count: 0,
          pages: [],
          includeInactive: !!s.inactive,
        },
      ]),
    ),
    reports: [],
    warnings: [],
    limitations: [
      "Independent QBO requests are not a point-in-time snapshot. Avoid source edits during extraction or resume.",
      "Standard Accounting API data only; deleted records, payroll, premium APIs, and binary attachment downloads are not included.",
      "Attachable metadata may contain temporary source URLs. They are not archived attachment files.",
    ],
  };
  await saveManifest(out, m);
  return m;
}
export async function writePage(
  out: string,
  m: Manifest,
  entity: string,
  rows: JsonObject[],
  done: boolean,
): Promise<void> {
  const state = m.entities[entity];
  if (!state || !ENTITY_SPECS.some((s) => s.entity === entity))
    throw new Error("Unknown entity");
  const path = `entities/${entity}/pages/${state.nextPosition}.json`;
  const file = await bundlePath(out, path);
  await atomicJson(file, rows);
  const page = { path, count: rows.length, sha256: hash(await readFile(file)) };
  state.pages.push(page);
  state.count += rows.length;
  state.nextPosition += rows.length;
  state.status = done ? "done" : "running";
  await saveManifest(out, m);
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid bundle: ${message}`);
}
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export async function loadManifest(out: string): Promise<Manifest> {
  const m = await jsonFile(await bundlePath(out, "manifest.json"));
  requireValue(
    isObject(m) && m.format === "lega-qbo-bundle" && m.version === 1,
    "unsupported format or version",
  );
  requireValue(
    isObject(m.source) &&
      /^\d+$/.test(String(m.source.realmId)) &&
      ["sandbox", "production"].includes(String(m.source.environment)) &&
      typeof m.source.minorVersion === "string",
    "source",
  );
  requireValue(
    typeof m.runId === "string" &&
      typeof m.startedAt === "string" &&
      typeof m.updatedAt === "string" &&
      ["extracting", "failed", "complete"].includes(String(m.status)),
    "run metadata",
  );
  requireValue(
    integer(m.pageSize) &&
      (m.pageSize as number) >= 1 &&
      (m.pageSize as number) <= 1000 &&
      typeof m.reportsPlanned === "boolean",
    "extraction configuration",
  );
  requireValue(
    isObject(m.entities) &&
      Object.keys(m.entities).length === ENTITY_SPECS.length &&
      ENTITY_SPECS.every((s) => Object.hasOwn(m.entities as object, s.entity)),
    "entity coverage",
  );
  requireValue(
    Array.isArray(m.reports) &&
      Array.isArray(m.warnings) &&
      m.warnings.every((s) => typeof s === "string") &&
      Array.isArray(m.limitations) &&
      m.limitations.every((s) => typeof s === "string"),
    "reports/warnings",
  );
  for (const spec of ENTITY_SPECS) {
    const s = (m.entities as JsonObject)[spec.entity];
    requireValue(
      isObject(s) &&
        ["pending", "running", "done", "unavailable"].includes(
          String(s.status),
        ) &&
        integer(s.count) &&
        integer(s.nextPosition) &&
        (s.nextPosition as number) >= 1 &&
        Array.isArray(s.pages) &&
        typeof s.includeInactive === "boolean",
      `coverage state ${spec.entity}`,
    );
    requireValue(
      s.status !== "unavailable" ||
        (spec.optional &&
          typeof s.reason === "string" &&
          s.reason.length &&
          s.count === 0),
      `unavailable coverage ${spec.entity}`,
    );
    requireValue(
      s.status !== "pending" ||
        (s.count === 0 && s.pages.length === 0 && s.nextPosition === 1),
      `pending state ${spec.entity}`,
    );
  }
  for (const r of m.reports)
    requireValue(
      isObject(r) &&
        typeof r.id === "string" &&
        /^[a-f0-9]{64}$/.test(r.id) &&
        typeof r.name === "string" &&
        isObject(r.params) &&
        Object.values(r.params).every((v) => typeof v === "string") &&
        ["balance", "period", "ageing", "inventory"].includes(
          String(r.purpose),
        ),
      "report schema",
    );
  return m as unknown as Manifest;
}
async function checkedFile(out: string, page: Page): Promise<unknown> {
  requireValue(
    isObject(page) &&
      typeof page.path === "string" &&
      integer(page.count) &&
      typeof page.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(page.sha256),
    "file schema",
  );
  const raw = await readFile(await bundlePath(out, page.path));
  requireValue(hash(raw) === page.sha256, `checksum ${page.path}`);
  return JSON.parse(raw.toString("utf8"));
}
export async function validateBundle(
  out: string,
  options: { allowIncomplete?: boolean } = {},
): Promise<Manifest> {
  const m = await loadManifest(out);
  const files = new Set<string>();
  let company: JsonObject = {},
    first: string | undefined;
  const accounts: JsonObject[] = [];
  for (const spec of ENTITY_SPECS) {
    const s = m.entities[spec.entity],
      ids = new Set<string>();
    let count = 0,
      position = 1;
    for (const p of s.pages) {
      requireValue(!files.has(p.path), "duplicate page path");
      files.add(p.path);
      // Check containment before the canonical filename check for clear errors.
      await bundlePath(out, p.path);
      requireValue(
        p.path === `entities/${spec.entity}/pages/${position}.json`,
        "page path or cursor",
      );
      const rows = await checkedFile(out, p);
      requireValue(
        Array.isArray(rows) && rows.length === p.count && rows.every(isObject),
        "page count or rows",
      );
      requireValue(rows.length <= m.pageSize, "page size");
      for (const row of rows) {
        const id = sourceId(spec.entity, row);
        requireValue(!ids.has(id), `duplicate source Id in ${spec.entity}`);
        ids.add(id);
        if (spec.entity === "CompanyInfo") company = row;
        if (spec.entity === "Account") accounts.push(row);
        if (isDate(row.TxnDate) && (!first || row.TxnDate < first))
          first = row.TxnDate;
      }
      count += rows.length;
      position += rows.length;
    }
    requireValue(
      count === s.count && position === s.nextPosition,
      `count/cursor ${spec.entity}`,
    );
    requireValue(
      s.status !== "unavailable" || s.pages.length === 0,
      "unavailable pages",
    );
    requireValue(
      s.status !== "done" || s.pages.length > 0,
      "completed resource has no page",
    );
    if (spec.single && s.status === "done")
      requireValue(count === 1, "singleton count");
  }
  const reportIds = new Set<string>();
  if (m.reportsPlanned) {
    requireValue(
      ENTITY_SPECS.every((s) =>
        ["done", "unavailable"].includes(m.entities[s.entity].status),
      ),
      "report plan before entity coverage",
    );
    requireValue(
      isDate(m.reportDate) &&
        m.firstTxnDate === first &&
        m.fiscalYearStartMonth === fiscalMonth(company.FiscalYearStartMonth),
      "report plan metadata",
    );
    const inventory = accounts.some((a) => a.AccountSubType === "Inventory")
      ? accounts
          .filter(
            (a) =>
              a.AccountSubType === "Inventory" ||
              a.AccountType === "Cost of Goods Sold" ||
              a.AccountSubType === "OpeningBalanceEquity",
          )
          .map((a) => String(a.Id))
      : [];
    const expected = planReports({
      firstTxnDate: first,
      cutOverDate: m.reportDate,
      fiscalYearStartMonth: m.fiscalYearStartMonth!,
      inventoryAccountIds: inventory,
    });
    requireValue(
      expected.length === m.reports.length &&
        expected.every((r, i) => {
          const saved = m.reports[i];
          const id = hash(
            JSON.stringify([
              r.name,
              Object.entries(r.params).sort(([a], [b]) => a.localeCompare(b)),
            ]),
          );
          return (
            saved.id === id &&
            saved.name === r.name &&
            saved.purpose === r.purpose &&
            JSON.stringify(Object.entries(saved.params).sort()) ===
              JSON.stringify(Object.entries(r.params).sort())
          );
        }),
      "report plan coverage",
    );
  } else requireValue(m.reports.length === 0, "unplanned reports");
  for (const r of m.reports) {
    requireValue(!reportIds.has(r.id), "duplicate report");
    reportIds.add(r.id);
    if (r.file) {
      requireValue(
        r.file.path === `reports/${r.id}.json` && r.file.count === 1,
        "report path/count",
      );
      const body = await checkedFile(out, r.file);
      requireValue(isQboReport(body, r.name), "report body");
      files.add(r.file.path);
    }
  }
  const complete =
    ENTITY_SPECS.every((s) =>
      ["done", "unavailable"].includes(m.entities[s.entity].status),
    ) &&
    m.reportsPlanned &&
    m.reports.length > 0 &&
    m.reports.every((r) => r.file);
  requireValue(
    m.status !== "complete" || (complete && typeof m.completedAt === "string"),
    "incomplete coverage marked complete",
  );
  if (!options.allowIncomplete)
    requireValue(m.status === "complete" && complete, "incomplete extraction");
  return m;
}
export async function* readEntity(
  out: string,
  entity: string,
  options: { allowIncomplete?: boolean } = {},
): AsyncGenerator<JsonObject> {
  const m = await validateBundle(out, options);
  if (!Object.hasOwn(m.entities, entity)) throw new Error("Unknown entity");
  for (const p of m.entities[entity].pages)
    for (const row of (await checkedFile(out, p)) as JsonObject[]) yield row;
}
