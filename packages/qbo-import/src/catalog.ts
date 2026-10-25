export interface EntitySpec {
  entity: string;
  single?: "companyinfo" | "preferences";
  inactive?: boolean;
  optional?: boolean;
}
// Ported from LEGA's independent extraction catalog; extensions retain source
// data even when no destination mapper currently exists.
export const ENTITY_SPECS: readonly EntitySpec[] = [
  { entity: "CompanyInfo", single: "companyinfo" },
  { entity: "Preferences", single: "preferences" },
  { entity: "Account", inactive: true },
  ...["Class", "Department", "Term"].map((entity) => ({
    entity,
    inactive: true,
    optional: true,
  })),
  { entity: "TaxAgency", optional: true },
  ...["TaxRate", "TaxCode", "PaymentMethod"].map((entity) => ({
    entity,
    inactive: true,
    optional: true,
  })),
  ...["Customer", "Vendor", "Item"].map((entity) => ({
    entity,
    inactive: true,
  })),
  ...["Invoice", "CreditMemo", "SalesReceipt"].map((entity) => ({ entity })),
  { entity: "RefundReceipt", optional: true },
  ...["Payment", "Deposit", "Bill", "BillPayment"].map((entity) => ({
    entity,
  })),
  { entity: "VendorCredit", optional: true },
  { entity: "Purchase" },
  { entity: "Transfer", optional: true },
  { entity: "JournalEntry" },
  ...["Estimate", "PurchaseOrder", "TimeActivity", "Attachable"].map(
    (entity) => ({ entity, optional: true }),
  ),
  { entity: "Employee", optional: true, inactive: true },
];
export function sourceId(entity: string, row: Record<string, unknown>): string {
  if (entity === "CompanyInfo" || entity === "Preferences") return entity;
  if (
    (typeof row.Id !== "string" && typeof row.Id !== "number") ||
    String(row.Id).length === 0
  )
    throw new Error(`Missing source Id in ${entity}`);
  return String(row.Id);
}
