#!/usr/bin/env node
import { resolve, relative, sep } from "node:path";
import { ConnectionStore } from "./auth.js";
import { loadConfig } from "./config.js";
import { connectBrowser } from "./prompt.js";
import { extractBundle } from "./extract.js";
import { loadManifest, validateBundle } from "./bundle.js";
import { QBO_MINOR_VERSION, sanitizeError } from "./client.js";
import { isDate } from "./reports.js";
import type { Manifest } from "./types.js";

const help = `Standalone LEGA QuickBooks Online import CLI (Node 18+)

  connect [--manual]                 Browser sign-in (production uses manual callback)
  extract --out DIR [--report-date YYYY-MM-DD] [--page-size 1..1000]
  resume --out DIR                   Resume a saved extraction
  status [--out DIR]                 Connection status, or local extraction status
  validate --out DIR                 Offline integrity and completeness validation
  disconnect                        Revoke connection and remove local tokens

Configure QBO_* in the repository root .env. See packages/qbo-import/README.md.
Saved bundles preserve raw QBO records for a separate future lega-v2 importer.
`;
function parse(args: string[]): {
  command: string;
  flags: Map<string, string>;
} {
  const [command, ...rest] = args;
  const allowed: Record<string, string[]> = {
    connect: ["manual"],
    extract: ["out", "report-date", "page-size"],
    resume: ["out"],
    status: ["out"],
    validate: ["out"],
    disconnect: [],
  };
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  )
    return { command: "help", flags: new Map() };
  if (!Object.hasOwn(allowed, command))
    throw new Error("Unknown command; run qbo:import --help");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith("--") ? rest[i].slice(2) : "";
    if (!allowed[command].includes(name) || flags.has(name))
      throw new Error("Unknown or repeated option; run qbo:import --help");
    if (name === "manual") {
      flags.set(name, "true");
      continue;
    }
    const value = rest[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Option requires a value");
    flags.set(name, value);
  }
  if (["extract", "resume", "validate"].includes(command) && !flags.has("out"))
    throw new Error("This command requires --out DIR");
  if (
    flags.has("page-size") &&
    !/^(?:[1-9]\d{0,2}|1000)$/.test(flags.get("page-size")!)
  )
    throw new Error("Page size must be an integer from 1 to 1000");
  if (flags.has("report-date") && !isDate(flags.get("report-date")))
    throw new Error("Report date must be a valid YYYY-MM-DD date");
  return { command, flags };
}
function summary(m: Manifest): object {
  return {
    status: m.status,
    runId: m.runId,
    source: m.source,
    companyName: m.companyName,
    homeCurrency: m.homeCurrency,
    reportDate: m.reportDate,
    startedAt: m.startedAt,
    updatedAt: m.updatedAt,
    completedAt: m.completedAt,
    entities: Object.fromEntries(
      Object.entries(m.entities).map(([name, s]) => [
        name,
        { status: s.status, count: s.count, reason: s.reason },
      ]),
    ),
    reports: {
      planned: m.reports.length,
      saved: m.reports.filter((r) => r.file).length,
    },
    warnings: m.warnings,
    limitations: m.limitations,
    error: m.error,
  };
}
function overlap(a: string, b: string): boolean {
  const r = relative(a, b);
  return !r || (!r.startsWith(".." + sep) && r !== ".." && !r.startsWith(sep));
}
async function main(): Promise<void> {
  const { command, flags } = parse(process.argv.slice(2));
  if (command === "help") {
    console.log(help);
    return;
  }
  const out = flags.has("out") ? resolve(flags.get("out")!) : undefined;
  if (command === "status" && out) {
    console.log(JSON.stringify(summary(await loadManifest(out)), null, 2));
    return;
  }
  if (command === "validate") {
    console.log(JSON.stringify(summary(await validateBundle(out!)), null, 2));
    return;
  }
  const config = loadConfig(),
    store = new ConnectionStore(config);
  if (command === "connect") {
    await connectBrowser(store, { manual: flags.has("manual") });
    console.log(JSON.stringify(await store.status(), null, 2));
    return;
  }
  if (command === "disconnect") {
    await store.disconnect();
    console.log("QuickBooks disconnected; saved bundles retained.");
    return;
  }
  if (command === "status") {
    console.log(
      JSON.stringify(
        (await store.status()) ?? { state: "disconnected" },
        null,
        2,
      ),
    );
    return;
  }
  if (out && (overlap(config.stateDir, out) || overlap(out, config.stateDir)))
    throw new Error("Export directory must be separate from QBO_STATE_DIR");
  const connection = await store.status();
  if (!connection)
    throw new Error("Connect to QuickBooks first: pnpm qbo:import connect");
  const source = {
    realmId: connection.realmId,
    environment: connection.environment,
    minorVersion: QBO_MINOR_VERSION,
  };
  const client = await store.client(source);
  const m = await extractBundle({
    out: out!,
    source,
    client,
    resume: command === "resume",
    reportDate: flags.get("report-date"),
    pageSize: flags.has("page-size")
      ? Number(flags.get("page-size"))
      : undefined,
    onProgress: (message) => console.error(message),
  });
  console.log(JSON.stringify(summary(m), null, 2));
}
main().catch((error) => {
  console.error(`QBO import: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
