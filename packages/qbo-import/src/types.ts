export type JsonObject = Record<string, unknown>;
export const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export type Environment = "sandbox" | "production";
export interface Source {
  realmId: string;
  environment: Environment;
  minorVersion: string;
}
export interface Page {
  path: string;
  count: number;
  sha256: string;
}
export interface EntityProgress {
  status: "pending" | "running" | "done" | "unavailable";
  nextPosition: number;
  count: number;
  includeInactive: boolean;
  pages: Page[];
  reason?: string;
}
export interface ReportRequest {
  name: string;
  params: Record<string, string>;
  purpose: "balance" | "period" | "ageing" | "inventory";
}
export interface SavedReport extends ReportRequest {
  id: string;
  file?: Page;
}
export interface Manifest {
  format: "lega-qbo-bundle";
  version: 1;
  runId: string;
  source: Source;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: "extracting" | "failed" | "complete";
  companyName?: string;
  homeCurrency?: string;
  pageSize: number;
  reportDate?: string;
  firstTxnDate?: string;
  fiscalYearStartMonth?: number;
  reportsPlanned: boolean;
  entities: Record<string, EntityProgress>;
  reports: SavedReport[];
  warnings: string[];
  limitations: string[];
  error?: string;
}
