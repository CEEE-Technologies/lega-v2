import { isObject, type JsonObject } from "./types.js";

/** Shared fetch/offline structural check. Preserve unknown report fields and
 * QBO's empty Rows representation; never substitute fabricated balances. */
export function isQboReport(value: unknown, name: string): value is JsonObject {
  if (
    !isObject(value) ||
    !isObject(value.Header) ||
    value.Header.ReportName !== name ||
    !isObject(value.Columns) ||
    !Array.isArray(value.Columns.Column) ||
    !value.Columns.Column.every(isObject)
  )
    return false;
  const noData =
    Array.isArray(value.Header.Option) &&
    value.Header.Option.some(
      (option) =>
        isObject(option) &&
        option.Name === "NoReportData" &&
        (option.Value === "true" || option.Value === true),
    );
  if (value.Rows === undefined) return noData;
  const groups: unknown[] = [value.Rows];
  while (groups.length) {
    const group = groups.pop();
    if (!isObject(group)) return false;
    if (group.Row === undefined) continue;
    if (!Array.isArray(group.Row)) return false;
    for (const row of group.Row) {
      if (!isObject(row)) return false;
      for (const cells of [
        row.ColData,
        isObject(row.Header) ? row.Header.ColData : undefined,
        isObject(row.Summary) ? row.Summary.ColData : undefined,
      ]) {
        if (
          cells !== undefined &&
          (!Array.isArray(cells) || !cells.every(isObject))
        )
          return false;
      }
      if (row.Rows !== undefined) groups.push(row.Rows);
    }
  }
  return true;
}
