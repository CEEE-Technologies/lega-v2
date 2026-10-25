# Standalone QuickBooks Online import CLI

Connect directly to QBO, extract its available standard accounting data, and keep a portable bundle for a later lega-v2 import. Runs on Node 18+ without the lega-v2 server, MariaDB, Redis, or the original LEGA checkout. The extraction/client/report approach is adapted from LEGA's QBO migration implementation.

This delivers the extraction stage. A future lega-v2 adapter must map these records into destination accounts, documents, payments and inventory. The bundle is **not** a CSV/XLSX file for the current in-app importer.

## Setup

From the repository root:

```sh
pnpm install
pnpm qbo:import --help
```

The root command builds this package automatically. To build once and call it repeatedly:

```sh
pnpm --filter @lega/qbo-import build
node packages/qbo-import/dist/cli.js --help
```

Create an [Intuit Developer app](https://developer.intuit.com/app/developer/myapps) with the QuickBooks Online Accounting API enabled. Use the matching sandbox or production credentials. Set these in the canonical **root `.env`**; existing process environment variables take precedence:

```dotenv
QBO_ENVIRONMENT=sandbox
QBO_CLIENT_ID=your-intuit-client-id
QBO_CLIENT_SECRET=your-intuit-client-secret
QBO_REDIRECT_URI=http://localhost:9477/callback
QBO_TOKEN_KEY=your-base64-encoded-32-byte-key
QBO_STATE_DIR=.qbo-state
```

Generate `QBO_TOKEN_KEY` once with `openssl rand -base64 32`. Keep that key stable, private, and separate from exports. Losing or changing it requires reconnecting. The CLI's `.env` resolution does not depend on the shell's working directory. `QBO_STATE_DIR` is relative to the repo root unless absolute.

**Sandbox:** register exactly `http://localhost:9477/callback` in your Intuit app. `connect` opens your browser and starts a temporary loopback callback listener. If automatic opening fails, open the printed authorization URL yourself. The listener closes after sign-in or after ten minutes. To use another loopback port, change both the configured and registered URI.

**Production:** set `QBO_ENVIRONMENT=production`, use production app credentials, and register an HTTPS callback URL on a domain you control. Intuit does not accept localhost production redirects. The CLI opens QBO sign-in; after authorization, copy the complete redirected address into the terminal's hidden prompt. The registered callback page must preserve the query in the address bar and avoid logging or forwarding authorization codes. This package does not provision a hosted callback page. Never paste the callback into chat, command arguments, or a shell command. Production always uses this manual completion; `connect --manual` also enables manual completion for sandbox.

Intuit references: [OAuth setup](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0), [sandbox versus production redirects](https://github.com/intuit/intuit-cli-for-quickbooks#prerequisites), [minor version 75 guidance](https://medium.com/intuitdev/changes-to-our-accounting-api-that-may-impact-your-application-c330bd1a06f5).

## Run

```sh
pnpm qbo:import connect
pnpm qbo:import status
pnpm qbo:import extract --out ./qbo-data/company-backup
pnpm qbo:import status --out ./qbo-data/company-backup
pnpm qbo:import validate --out ./qbo-data/company-backup
```

Select the source company in the QBO browser authorization. Each state directory holds one connection. For another company, use another `QBO_STATE_DIR` or reconnect. A run pins the realm, environment and API version; it cannot resume against a different company.

`extract` requires a new output directory and never replaces an existing run. If the network fails, a required resource is denied, or the process stops, fix the cause and run:

```sh
pnpm qbo:import resume --out ./qbo-data/company-backup
```

Completed pages and reports are retained and checked before resuming. The same uncommitted page may be re-fetched after a crash; it replaces that page instead of appending duplicates. Corrupt committed pages stop resume: preserve the old bundle and start a fresh output directory rather than editing its manifest to bypass validation.

Optional extraction flags:

```sh
pnpm qbo:import extract --out ./qbo-data/as-of-run --report-date 2026-10-25 --page-size 1000
```

`--report-date` controls reconciliation reports only. Entity extraction always includes all history exposed by QBO. The default report date is today in Asia/Colombo, or the latest extracted transaction date if later. The default page size is 1000 (allowed 1–1000). `resume` uses saved settings.

Progress goes to stderr; status/completion summaries are JSON on stdout. Fatal errors and incomplete validation exit 1. A complete bundle can still have warnings about explicitly unavailable optional entities or inactive-record filtering. Review warnings before deciding whether the source coverage is sufficient for your migration.

`status --out` and `validate --out` work offline without `.env` or credentials. `status --out` reports saved metadata; **validate** checks integrity. `disconnect` attempts QBO revocation and removes the local connection/pending authorization, retaining exports. A revocation failure is reported even though local credentials were removed.

## Coverage

All returned nested fields, lines, references, source IDs, tax details, currencies, and unknown future properties are retained with their QBO casing. No destination mapping, case conversion, flattening, or accounting rounding is applied.

| Group                          | Resources                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Company                        | CompanyInfo, Preferences                                                                                                              |
| Masters                        | Account, Class, Department, Term, TaxAgency, TaxRate, TaxCode, PaymentMethod, Customer, Vendor, Item                                  |
| Transactions                   | Invoice, CreditMemo, SalesReceipt, RefundReceipt, Payment, Deposit, Bill, BillPayment, VendorCredit, Purchase, Transfer, JournalEntry |
| Additional source preservation | Estimate, PurchaseOrder, TimeActivity, Employee, Attachable metadata                                                                  |

Where supported, inactive masters are included. Class, Department, Term, TaxAgency, TaxRate, TaxCode, PaymentMethod, RefundReceipt, VendorCredit, Transfer and the five additional resources are optional. A documented unsupported query/permission response marks an optional resource unavailable with a warning. Transient failures, malformed responses, and authentication failures never count as empty data. Required resource failures stop the run. Successful empty queries are represented as completed zero-record resources.

Reports use accrual accounting: BalanceSheet, TrialBalance and ProfitAndLoss per fiscal year through the report date, plus AgedReceivables and AgedPayables at that date. When inventory exists, GeneralLedger also covers inventory assets, cost-of-goods-sold and opening-balance-equity accounts per fiscal year. All planned reports must succeed. Missing/unknown fiscal-year metadata defaults to January with a warning.

Limitations:

- QBO paginated reads are **not a point-in-time database snapshot**. Avoid editing source books during extraction or resume. Reports and entity reads can otherwise reflect different moments.
- Deleted records, payroll, premium APIs, and binary attachment files are excluded. Attachable metadata may contain temporary download URLs; those links are not archived files and may expire.
- Completeness means the documented resource/report catalog completed, with optional coverage warnings recorded. It does not mean every QBO product or UI feature is exportable through the Accounting API.
- Checksums detect accidental corruption, not malicious rewriting of both data and manifest. Treat bundles as private company records from a trusted source.

## Bundle format and later importer

```text
company-backup/
  manifest.json
  entities/<QBO-Entity>/pages/<start-position>.json
  reports/<sha256-of-report-request>.json
```

The manifest format is `lega-qbo-bundle`, version `1`. It records the run ID, realm/environment, minor API version (`75`), extraction timestamps, page size, per-entity cursor/status/counts, report names/parameters/purpose, warnings and limitations. Committed files have SHA-256 hashes and record counts. Entity files contain arrays of original QBO objects; CompanyInfo/Preferences are single-element arrays. Report files contain complete QBO report JSON.

Offline validation checks the manifest/version, fixed coverage catalog, safe file paths and symlinks, file checksums, page counts/cursors, duplicate source IDs and planned report coverage. A required missing file, corrupt file, missing report or incomplete run fails validation.

The package exports `Manifest`, `Source`, `validateBundle`, and `readEntity` for the later adapter:

```ts
import { validateBundle, readEntity } from "@lega/qbo-import";

const manifest = await validateBundle("/absolute/path/to/company-backup");
for await (const customer of readEntity(
  "/absolute/path/to/company-backup",
  "Customer",
)) {
  // Resolve by (manifest.source.realmId, 'Customer', customer.Id).
  // Map to destination DTOs only in the future lega-v2 adapter.
}
```

Validate before any destination writes. Preserve `(realmId, entity, sourceId)` mappings for linked records and import idempotency. Raw QBO values retain their case; lega-v2 API request serialization belongs in the later adapter. Keep exports immutable while reading/importing. `allowIncomplete: true` exists for extraction recovery/inspection and must not be used to bypass completion before an actual import.

## Local state and locks

The default `.qbo-state/` stores AES-256-GCM encrypted tokens with private file permissions; `.env` holds the encryption key. Export files/directories are also created private. `.qbo-state/` and the default `qbo-data/` are Git-ignored. If you choose custom locations, exclude them from version control and backups shared with others as appropriate.

Only one writer can hold a bundle lock, and connection refreshes are serialized. A lock names its local PID and hostname. A later run can recover a lock whose local owner is confirmed dead; live/remote/ownerless locks are not automatically removed. After a crash, inspect an ownerless lock or `.recovery` directory, confirm no CLI process is running, and remove only that stale lock. Never delete a lock held by an active extraction. Locks live beside the output directory or inside `QBO_STATE_DIR`.

## Development verification

```sh
pnpm --filter @lega/qbo-import test
pnpm --filter @lega/qbo-import typecheck
pnpm --filter @lega/qbo-import build
```

Tests use synthetic responses and a local fake QBO HTTP server, covering OAuth callbacks, token rotation, malformed API responses, multipage extraction, interruption/resume, report reconciliation planning and offline validation. A live QBO smoke test additionally requires your Intuit credentials and interactive authorization; automated tests do not authorize or read a real company.
