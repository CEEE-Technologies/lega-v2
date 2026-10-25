import { type ReportRequest } from "./types.js";
export function isDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "1900-01-01" &&
    value <= "9998-12-31" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function fiscalMonth(value: unknown): number {
  const index = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(String(value ?? "").toLowerCase());
  return index < 0 ? 1 : index + 1;
}
const dayBefore = (date: string) =>
  new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
const firstDay = (year: number, month: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
export function planReports(input: {
  firstTxnDate?: string;
  cutOverDate: string;
  fiscalYearStartMonth: number;
  inventoryAccountIds: string[];
}): ReportRequest[] {
  if (
    !isDate(input.cutOverDate) ||
    (input.firstTxnDate !== undefined && !isDate(input.firstTxnDate))
  )
    throw new Error("Invalid report date");
  const month = input.fiscalYearStartMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12)
    throw new Error("Invalid fiscal month");
  const first =
    input.firstTxnDate && input.firstTxnDate < input.cutOverDate
      ? input.firstTxnDate
      : input.cutOverDate;
  let year = Number(first.slice(0, 4));
  if (first < firstDay(year, month)) year--;
  const reports: ReportRequest[] = [];
  for (;;) {
    const from = firstDay(year, month),
      end = dayBefore(firstDay(year + 1, month));
    const to = end < input.cutOverDate ? end : input.cutOverDate;
    for (const name of ["BalanceSheet", "TrialBalance", "ProfitAndLoss"])
      reports.push({
        name,
        params: {
          accounting_method: "Accrual",
          start_date: from,
          end_date: to,
        },
        purpose: name === "ProfitAndLoss" ? "period" : "balance",
      });
    if (input.inventoryAccountIds.length)
      reports.push({
        name: "GeneralLedger",
        params: {
          accounting_method: "Accrual",
          start_date: from,
          end_date: to,
          account: [...input.inventoryAccountIds].sort().join(","),
          columns:
            "tx_date,txn_type,doc_num,subt_nat_amount,account_name,name,memo",
        },
        purpose: "inventory",
      });
    if (end >= input.cutOverDate) break;
    year++;
  }
  for (const name of ["AgedReceivables", "AgedPayables"])
    reports.push({
      name,
      params: {
        report_date: input.cutOverDate,
        aging_period: "30",
        num_periods: "4",
      },
      purpose: "ageing",
    });
  return reports;
}
export function today(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
