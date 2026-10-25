import { test } from "node:test";
import assert from "node:assert/strict";
const reports = await import("../dist/reports.js").catch(() => ({}));
test("plans fiscal periods across leap day with reconciliation and inventory reports", () => {
  assert.equal(typeof reports.planReports, "function");
  const plan = reports.planReports({
    firstTxnDate: "2023-04-01",
    cutOverDate: "2024-02-29",
    fiscalYearStartMonth: 4,
    inventoryAccountIds: ["8", "2"],
  });
  assert.equal(plan.length, 6);
  assert.deepEqual(plan[0], {
    name: "BalanceSheet",
    params: {
      accounting_method: "Accrual",
      start_date: "2023-04-01",
      end_date: "2024-02-29",
    },
    purpose: "balance",
  });
  assert.equal(plan[3].params.account, "2,8");
  assert.equal(plan[4].params.report_date, "2024-02-29");
});
test("plans multiple fiscal years and rejects invalid calendar dates", () => {
  assert.equal(typeof reports.planReports, "function");
  const plan = reports.planReports({
    firstTxnDate: "2023-01-01",
    cutOverDate: "2024-01-01",
    fiscalYearStartMonth: 1,
    inventoryAccountIds: [],
  });
  assert.equal(plan.length, 8);
  assert.equal(plan[0].params.end_date, "2023-12-31");
  assert.equal(plan[3].params.start_date, "2024-01-01");
  assert.throws(
    () =>
      reports.planReports({
        cutOverDate: "2023-02-29",
        fiscalYearStartMonth: 1,
        inventoryAccountIds: [],
      }),
    /date/i,
  );
});
