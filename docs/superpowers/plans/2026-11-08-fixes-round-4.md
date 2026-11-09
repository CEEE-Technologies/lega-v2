# Fixes, round 4

Status: **approved 8 Nov 2026** with the recommended answers to D1–D9. Work is on branch `fix/round-4` (PR 27).

**9 Nov 2026:** Parts 5 and 6 added on the same branch and PR: the Codex review comment, every item left open, and a sweep of the areas never checked. Stripe and Plaid stay out.

Written 8 Nov 2026. Every item was re-checked against `origin/develop` at `3fb371197` (after PRs 19–26). It follows [2026-11-07-critical-fixes-round-3.md](2026-11-07-critical-fixes-round-3.md), which is fully merged.

**Where these came from:**

- Issues the round-3 PRs (19–25) found "in passing" and left out of scope.
- Problems seen in the final round-3 test run.

**Left out on purpose:** everything to do with Stripe or Plaid, as you asked (see "Not in this plan").

**In this plan:** 16 fixes in 4 parts, in **one branch and one pull request**, one commit per fix. Each item says:

- **The issue today:** what goes wrong, and where in the code.
- **Before:** an example of what happens now.
- **The fix:** what will change.
- **After:** the same example once fixed.
- **Test:** how the fix is proved.

**How bad each one is:**

- **High:** wrong money in the books, a security gap, or no way to check the release.
- **Medium:** a broken feature, a misleading error, or a rare way to damage data.

Paths are relative to `packages/server/src/modules/` unless they start with `webapp/`, `test/`, `e2e/` or a root file name.

> **Two numbering systems.** The health check command has its own section numbers (H1–H16). This plan's items are numbered **F1–F16**, so "H11" below always means the health check section.

---

## Words used below

- **Ledger / books:** the master record of every money movement. All reports are built from it.
- **Handler:** code that runs when something happens, for example "a bill was created". Errors in a handler now stop the save (round 3, E1).
- **Transaction (database):** a group of changes saved all together or not at all.
- **Deadlock:** two saves waiting on each other. The database cancels one of them and undoes **all** of its work so far.
- **Base currency:** the company's own currency. **Rate:** how much base currency one unit of the foreign currency is worth. The server always computes `foreign amount × rate = base amount`.
- **Landed cost:** freight or customs from one bill or expense, added onto the cost of items on another bill.
- **Repair command:** an opt-in command-line tool, like `tenants:repair-stale-journals`. It lists problems with `--dry-run` and changes them only with `--apply`. It never runs by itself, skips locked periods, and exits with an error if any repair failed.

---

## Decisions needed from you

Approving the plan means accepting the recommended answers, unless you say otherwise.

| #   | Question                                                                                                                                                                                                           | Recommended                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **F6:** who can deactivate, reactivate or remove an **Admin**?                                                                                                                                                     | Only the owner and other admins. This is the same rule as giving the Admin role (round 3, D5)                                                                                       |
| D2  | **F7:** how to stop a role editor from building a near-admin role?                                                                                                                                                 | A non-admin can only give a role permissions they hold themselves: when creating or editing a role, and when inviting someone or changing someone's role                            |
| D3  | **F2:** the audit log, today written inside the save. Write it right **after** the save commits, or keep it inside and stop the save when a deadlock hits it?                                                      | After the commit. It can then never break a save, and an undone save logs nothing. The cost: if the server crashes in the split second after a commit, that one audit entry is lost |
| D4  | **F3:** freight allocated from an inventory line (counted in stock twice). The repair removes the allocation, so the freight stays once, in the freight item's own stock. Re-allocating it properly is left to you | Yes. Opt-in command only, run per company                                                                                                                                           |
| D5  | **F4:** the stock repair sets each item's quantity per warehouse, and its total, from its stock movements                                                                                                          | Yes, both. Opt-in command only                                                                                                                                                      |
| D6  | **F10:** do you use **real S3** (AWS or similar) for attachments in production?                                                                                                                                    | If yes: a repair command makes every existing file private. If no: the item is dropped, because the bundled storage isn't reachable from outside                                    |
| D7  | **F12:** if the right-click menu bug is in the old `react-use-context-menu` library, may it be replaced with Blueprint's own context menu (already installed)?                                                     | Yes. It touches every list, so every list's right-click gets a browser test                                                                                                         |
| D8  | **F16:** checks must run on Node 18.16.1, as in production. nvm isn't installed, so Node 18 runs per command through npx (`npx -p node@18.16.1`), with nothing installed system-wide                               | Yes. If that doesn't work, you'll be asked before anything is installed                                                                                                             |
| D9  | How the work runs                                                                                                                                                                                                  | One session on one branch (`fix/round-4`), one commit per fix, one PR. Parts 1–4 in order. No parallel sessions, because they would edit the same branch                            |

---

## How the work will run

**One branch, one PR, one commit per fix.**

- Branch `fix/round-4` from `develop`.
- Each fix is its own commit, with its test in the same commit: `fix(server): F1 …`, `fix(webapp): F11 …`, and so on.
- The PR is opened only after the final review loop below comes back clean.

**Fixing critical issues found along the way.** While working, the session will read a lot of nearby code. When it finds a new issue:

- **Critical** means wrong money in the books, lost data, a security gap, or a crash on a main screen. For a critical issue it:
  1. writes a test that shows it;
  2. fixes it in its own commit (`fix: (found) …`);
  3. adds it to the PR's "Found and fixed" list.
- **Anything else** is listed in the PR's "Found in passing (not fixed)" section, with file and line, and not changed. This keeps the PR reviewable.

**Final review loop, before the PR is opened.** Repeated until a full pass finds nothing:

1. Run every check (see "How every fix will be verified") on Node 18.16.1.
2. Run a code review of the whole branch against `develop`.
3. Fix each confirmed problem in its own commit, with a test, then go back to step 1.
4. Stop after 3 loops even if findings remain, and tell you what's left instead of opening the PR.

---

# Part 1: Money and books

### F1. The exchange rate is labelled the wrong way round in four payment dialogs (High)

**The issue today**

1. The rate field shows `1 {from} = {rate} {to}` (`webapp/src/components/ExchangeRate/ExchangeRateMutedField.tsx:62`, popover at `ExchangeRateInput.tsx:143,158`).
2. These four dialogs pass `fromCurrency={baseCurrency}` and `toCurrency={values.currencyCode}`, the wrong way round:
   - `webapp/src/containers/Dialogs/QuickPaymentReceiveFormDialog/QuickPaymentReceiveFormFields.tsx:107`
   - `QuickPaymentMadeFormDialog/QuickPaymentMadeFormFields.tsx:99`
   - `RefundCreditNoteDialog/RefundCreditNoteFormFields.tsx:159`
   - `RefundVendorCreditDialog/RefundVendorCreditFormFields.tsx:131`
3. Every other form (invoices, bills, payments, expenses, journals) has it the right way round. Round 3 fixed the same bug in the opening-balance dialogs (Q10, commit `74f584888`).
4. The server computes `amount × rate` (`PaymentReceived/models/PaymentReceived.ts:72`, `BillPayments/models/BillPayment.ts:72`, `CreditNoteRefunds/commands/RefundCreditNoteCashGL.ts:28`, `VendorCreditsRefund/commands/RefundVendorCreditCashGL.ts:25`).

**Before**

1. A USD company has a EUR customer. The rate is 1.10. The customer pays €100 through "quick payment".
2. The dialog says **"1 USD = 1.10 EUR"**.
3. A user who corrects it to match the wording enters 0.909. The books get **$90.91** instead of $110, and the invoice shows a false exchange loss.

**The fix:** swap the two props in all four dialogs, with the same comment Q10 added.

**After:** the dialog says **"1 EUR = 1.10 USD"**, and $110 is posted.

**Test:** a Playwright test in the style of Q10. An AED company with a USD customer and vendor at rate 3.67: open each of the four dialogs and check the text `1 USD = 3.67 AED`.

---

### F2. A deadlock in the audit log can leave ledger rows for a save that was undone (Medium, rare but serious)

**The issue today**

1. `EE/AuditLogs/subscribers/FinancialAuditLog.subscriber.ts` has 98 handlers marked "ignore errors". Each one writes its audit row with the save's database transaction (`write()` at lines 166–174 → `EE/AuditLogs/AuditLog.service.ts:36-55`).
2. If that insert hits a deadlock (MySQL error 1213), the database undoes the **whole** transaction. The connection then quietly carries on without one.
3. The handler ignores the error, so the save keeps going. The other handlers (ledger, stock) and the rest of the save each run as separate, automatically committed statements. The user sees "saved".
4. It's the only "ignore errors" handler that writes with the transaction. The others (SMS, bank rules) only schedule work for after the commit (`common/events/EventHandlersErrorPolicy.spec.ts:21-36`).

**Before:** two users save bills at the same moment and the audit inserts deadlock. Bill #42 and its lines are undone. Its ledger and stock rows are saved anyway, so the Balance Sheet shows 500 of A/P for a bill that doesn't exist.

**The fix (D3):**

- `write()` records the audit row with `runAfterTransaction(trx, …)` and no transaction: it runs only once the save has committed (`Tenancy/TenancyDB/TransactionsHooks.ts:75-100`).
- Update the reviewed-list entry and its reason in `EventHandlersErrorPolicy.spec.ts`.
- Delete the dead copy `modules/AuditLogs/` (its module is imported nowhere) so it can't be fixed in one place and not the other.

**After:** a deadlock can't happen inside the save any more. An undone save logs nothing, and a committed save logs as before.

**Test:**

- Unit: with the audit insert set to fail with error 1213, a bill save still succeeds, and the audit insert runs only after the commit.
- e2e: a save that is undone writes no audit row; a normal save writes one, with the right user.

---

### F3. Freight allocated from an inventory line is in stock twice, and nothing repairs it (High, existing data)

**The issue today**

1. Before round 3's Q9 fix, the API let you allocate a landed cost from an **inventory** bill line. Q9 stopped new cases (`EE/BillLandedCosts/LandedCostsBridge.provider.ts:109-119`) but left old ones as they were.
2. That line's cost already went into stock when the bill was saved. The allocation adds it again to the other items. It credits the line's cost account, usually Cost of Goods Sold, which the bill never debited (`LandedCostGLEntries.service.ts:94-176`).
3. Health check section **H11 (c)** already lists these (`AccountingBasis/DataHealthCheckRound3.ts:461-470`). It found 46 on the local test companies. There is no repair.

**Before**

1. A 200 freight line on inventory item "Freight" is allocated onto goods bill G.
2. Inventory goes up 400 instead of 200, and Cost of Goods Sold is credited 200 (it goes negative).
3. G's items carry an inflated unit cost, so later cost of sales is wrong too.

**The fix (D4):** a new repair command, `tenants:repair-landed-costs-from-inventory`, built like `tenants:repair-stale-journals`.

- `--dry-run` lists what H11 (c) finds, and marks locked periods.
- `--apply` (needs `--organization`) removes each allocation with the existing undo, `RevertAllocatedLandedCost.deleteAllocatedLandedCost`, each in its own transaction. That undo already removes the stock and ledger rows, resets the source line, and schedules the cost recompute.
- The output tells you to re-enter the freight as a service line and allocate it again if you want it on the goods.

**After:** Inventory is up 200 once and Cost of Goods Sold is back to 0. H11 (c) is clean.

**Test (e2e, own company):**

1. Plant an inventory-line allocation directly in the database, the same way `test/data-health-check-round-3.e2e-spec.ts` does.
2. The dry run lists it and changes nothing.
3. `--apply` removes the allocation and its stock and ledger rows, and resets the source line's allocated amount to 0.
4. A locked-period allocation is skipped.
5. A second dry run lists nothing.

---

### F4. Stock per warehouse can be too high after round 3's duplicate-row merge, and nothing recalculates it (Medium, existing data)

**The issue today**

1. Round 3's Q3 migration merged duplicate stock rows by **adding** them together (`database/tenant/migrations/20261107130000_unique_items_warehouses_quantity.ts:68-78`). With the old bug, both rows had received every change, so the total is double.
2. Health check section **H3 (b)** shows the difference from the stock movements (`AccountingBasis/DataHealthCheck.ts:592-686`). Nothing can recalculate stored quantities from the movements: the only writers add or subtract (`Warehouses/Integrations/WarehousesItemsQuantitySync.ts:78-115`).

**Before:** "Chair / Main warehouse" had 2 rows of 5 each, while the real stock was 5. After the migration it shows **10**. Invoices let you sell 10, and the stock report is wrong.

**The fix (D5):** a new repair command, `tenants:repair-stock-quantities`.

- `--dry-run` lists every item and warehouse where the stored quantity differs from its movements ("Chair / Main: stock shows 10, movements add up to 5").
- `--apply` sets each warehouse quantity, and each item's total quantity, from the movements, in one transaction per company with the rows locked. Warehouse rows are only touched when multi-warehouse is on.

**After:** Chair / Main shows 5, and H3 is clean.

**Test (e2e, own company with warehouses on):** make a bill and an invoice, then double one warehouse row directly in the database. The dry run lists it; `--apply` fixes it; H3 (b) is clean; a second run lists nothing.

---

### F5. A bank line can't be matched to a manual journal (Medium)

**The issue today**

1. `BankingMatching/queries/GetMatchedTransactionsByManualJournals.service.ts:28-29` hard-codes the bank account as `1000` (`// @todo`). Journals on any other bank account are never offered.
2. When matching, `getMatchedTransaction(id)` (lines 66–77) doesn't load the journal's lines, so its amount is always 0. The match is refused with `TOTAL_MATCHING_TRANSACTIONS_INVALID` (`commands/MatchTransactions.ts:114-116`).
3. The amount filters use the journal's total, not the amount on the bank account (lines 47–52).

**Before:** a journal debits "Business Checking" 500 and credits Income 500. A +500 deposit on Business Checking doesn't list the journal. Matched through the API, it's refused.

**The fix**

- Pass the bank line's account to the candidate list and to the match check (`GetMatchedTransactions.service.ts:72`, `MatchTransactions.ts:76-94`).
- For journals, list only those with a line on that account, and take the amount from those lines only (debit − credit, with the sign giving the direction).
- Apply the min/max filters to that amount.

**After:** the journal is listed at 500, and the match succeeds.

**Test (e2e):**

1. On a bank account that isn't 1000, a +500 deposit lists the journal and matches it.
2. A −300 withdrawal matches a journal that credits the bank 300.
3. A journal that doesn't touch the bank isn't listed.

---

# Part 2: Permissions and errors

### F6. A user with "Manage users" can deactivate or remove an Admin (High)

**The issue today**

1. `UsersModule/commands/InactivateUser.service.ts:30-63` and `DeleteUser.service.ts:27-55` only check "not yourself" and "not the owner".
2. `ActivateUser.service.ts:26-57` has no owner or admin check at all.
3. All three endpoints need only "Manage users" (`UsersModule/Users.controller.ts:68,126,148`).
4. Round 3 (S11) protected only the Admin _role_ (`Roles/AdminAccess.service.ts`).

**Before:** Manny has only "Manage users". He deactivates or removes Ana, an Admin, and it succeeds. He can lock out every admin except the owner. He can also re-enable an admin the owner had deactivated.

**The fix (D1):** in all three services, if the target user has the Admin role, call `adminAccess.throwUnlessAdmin()`. Manny gets "Only an admin can do this." The users list shows that message, which is checked in the browser.

**After:** Manny's request is refused. He can still deactivate non-admins. The owner and other admins can manage admins.

**Test:** e2e tests in `test/security-round-3.e2e-spec.ts` style:

- Manny deactivates, removes or reactivates an admin: refused.
- Manny deactivates a staff user: allowed.
- The owner and an admin deactivate an admin: allowed.

---

### F7. A role editor can build a near-admin role and hand it out (Medium)

**The issue today**

1. `Roles/commands/CreateRole.service.ts:27-51` only checks that the permission names are valid.
2. `EditRole.service.ts:44-49` only protects the Admin role and the editor's own role.
3. Inviting someone or changing their role checks only for the Admin role (`UsersModule/commands/InviteUser.service.ts:62`, `EditUser.service.ts:133-145`).

**Before**

1. Rory can only edit roles. He adds "Manage users" and "Edit roles" to the Staff role, which then has near-admin power.
2. Or a user with "Create roles" and "Manage users" creates a role with every permission, then invites a second email they own with it.

**The fix (D2):** a non-admin may only:

- create or edit a role whose permissions they hold themselves;
- give a role, through invite or edit user, whose permissions they hold themselves.

Checked against the user's own permissions. Admins and the owner are unchanged.

**After:** Rory's edit is refused with a clear message. Editing a role with permissions Rory has (for example customer view) still works.

**Test (e2e):**

- Each of the three routes refuses a role with a permission the caller lacks.
- Each allows a role whose permissions the caller holds.
- Admins can do everything.
- The existing round-3 test "a role editor can still edit another role" still passes.

---

### F8. Deleting a customer or vendor with transactions gives a raw 500 instead of a clear message (Medium)

**The issue today**

1. The vendor check for vendor credits is entirely commented out and not registered (`VendorCredit/subscribers/DeleteVendorAssociatedVendorCredit.ts`).
2. The vendor delete only checks bills (`Vendors/models/Vendor.ts:195-219`, `DeleteVendor.service.ts:46-52`).
3. The customer model's relations are all commented out (`Customers/models/Customer.ts:207-232`), so customer delete only checks credit notes.
4. Everything else, such as vendor credits, bill payments, invoices, receipts, payments and estimates, is stopped by a database foreign key. That gives a generic **500**.
5. The webapp has a friendly message for `VENDOR_HAS_TRANSACTIONS` and `CUSTOMER_HAS_TRANSACTIONS` that never shows (`webapp/src/containers/Vendors/utils.tsx:24-31`).
6. Bulk delete lists these contacts as "can't delete", with no reason.

**Before:** deleting vendor "Acme", which has one vendor credit and no bills, gives "Something went wrong" (500). Nothing is deleted, but the user doesn't know why.

**The fix:**

- Bring back the vendor credit check, using today's model style, and register it.
- Wire up the existing unused validators so a contact with any transaction is refused with `VENDOR_HAS_TRANSACTIONS` or `CUSTOMER_HAS_TRANSACTIONS`:
  - `BillPaymentValidators.validateVendorHasNoPayments`, `BillsValidators.validateVendorHasNoBills`;
  - the invoice, receipt, payment and estimate validators for customers.

**After:** "This vendor can't be deleted because it has transactions", and bulk delete gives the same reason.

**Test (e2e):**

- Vendor: refused for a vendor credit, a bill payment and a bill. Allowed once those are deleted.
- Customer: refused for an invoice, a receipt, an estimate and a payment. Allowed once those are deleted.

---

### F9. PDF errors give a 500 or a broken PDF (Medium)

**The issue today:** `packages/server/src/libs/chromiumly/GotenbergUtils.ts:11-23` has two bugs.

1. When the PDF service is down, it logs the error and returns nothing. The invoice PDF endpoint then crashes on `pdfContent.length` (`SaleInvoices/SaleInvoices.controller.ts:250`), and the user gets a 500.
2. It builds a bare `new Axios(...)`, which never treats an error status as an error. So an error page from the PDF service is sent to the user **as the PDF**, with status 200.

The same applies to every PDF:

- estimates, receipts, credit notes and payments;
- payment links and exports;
- about 17 report PDFs;
- invoice emails with the PDF attached (`SaleInvoices/commands/SendSaleInvoiceMail.ts:115-123`).

**Before:** the PDF service is restarting. A user downloads an invoice and gets a file that won't open. Or the invoice email goes out with a broken attachment.

**The fix:**

- Use `axios.post` with a normal status check and a timeout.
- On any failure, or a reply that isn't a PDF, raise a clear error: 502 `PDF_RENDER_FAILED`, "The PDF service is unavailable, try again".
- Check at startup that `GOTENBERG_URL` is set.

**After:** the user sees the message, and no broken PDF is sent or emailed.

**Test:**

- Unit: PDF service unreachable → 502; error status → 502; a real PDF reply → returned.
- e2e: with `GOTENBERG_URL` pointed at a closed port, the invoice PDF endpoint answers 502 `PDF_RENDER_FAILED`.

---

### F10. Attachments uploaded before round 3 are still public (High if you use real S3; see D6)

**The issue today:** round 3 (S12) made **new** uploads private (`Attachments/Attachment.module.ts:89-91`). Files uploaded before that still carry `public-read` on the bucket, so anyone with a file's address can open it.

**Before:** an invoice scan uploaded in October can be opened by anyone who has its link.

**The fix:** a repair command, `attachments:make-private`:

- `--dry-run` lists every attachment key per company;
- `--apply` sets each one private on the bucket and reports failures.

If the bucket has ACLs switched off ("bucket owner enforced"), the command says so and stops, because the files were never public.

**After:** old files open only through the app's signed links, the same as new ones.

**Test:** against the local S3-compatible storage. Upload a file as `public-read` directly, check it opens without signing in, run `--apply`, and check it no longer opens while the signed link still works.

---

### F11. A recognized bank line with no rule suggestion crashes (500) (Medium)

**The issue today**

1. `BankingTranasctionsRegonize/queries/GetRecognizedTransaction.service.ts:23-38` loads a bank line by id even when no rule recognized it.
2. The transformer then reads `recognizedTransaction.assignedAccountId` from a missing record (`GetRecognizedTransactionTransformer.ts:124`, also lines 133–259).
3. It's one of the e2e failures (`test/banking-recognized.e2e-spec.ts`).

**Before:** opening a bank line that no rule matched gives a 500.

**The fix:**

- Only find recognized lines (`.whereNotNull('recognizedTransactionId')` before `throwIfNotFound()`), so the rest answer 404.
- Guard the transformer's reads of the rule and the account.
- Fix the `assignedPayee` field, which is never output because its method name doesn't match.

**After:** a 404 for an unrecognized line; 200 with the rule and account for a recognized one.

**Test:** e2e tests:

- line with no rule → 404;
- line matched by a rule → 200, with `assignedAccountId` and `bankRuleId`;
- unknown id → 404.

Plus a transformer unit test with no rule suggestion.

---

# Part 3: Screens

### F12. Right-click row menus don't open in the invoice and expense lists (Medium, cause to be found first)

**The issue today**

1. Every list uses one row component, `webapp/src/components/Datatable/TableRow.tsx`. Its right-click menu comes from `react-use-context-menu` 0.1.4, an unmaintained library from React 16 days. The app runs React 18.3.1 and Blueprint 4.20.2.
2. The hooks run inside a plain function call through `ConditionalWrapper` (`webapp/src/utils/index.tsx:273-278`), which breaks React's hook rules.
3. Nothing in the menu code has changed recently, so the cause isn't known from reading.
4. The repo's own `e2e/invoices.spec.ts` delete test fails the same way.

**Before:** right-clicking an invoice row shows nothing, so "Edit" and "Delete" from the row menu can't be reached.

**The fix:**

1. **First,** a Playwright trace of the invoice delete test. Find out whether the menu renders but stays invisible, never renders, or is covered by something. Compare with lists whose right-click tests pass: accounts, customers, estimates, item categories.
2. **Then,** fix the cause. If it's the library (D7), replace it with Blueprint's `ContextMenu2` from `@blueprintjs/popover2` (already installed), and make the row menu a proper component.

**After:** right-click opens the menu on every list.

**Test:** the existing invoice and expense edit and delete Playwright tests pass. A new test right-clicks one row in each list that has a menu.

---

# Part 4: Tooling and tests

### F13. The money repair `--apply` fails from the built command line (Medium)

**The issue today:** `CLI/commands/TenantsMoneyRepair.command.ts:209-216` loads three services with `await import('@/…')`. The build only rewrites `@/` in normal imports, not in `import()` calls. So the built `node dist/cli.js tenants:money-repair --apply` fails with "Cannot find module", which is how it would run in Docker or production. It works only through ts-node.

**The fix:**

- Use relative paths, as the sibling repair commands do.
- Add a lint rule that rejects `import('@/…')`.
- Add a check that the build output contains no `require('@/`.

**Test:** build, then run `node dist/cli.js tenants:money-repair --organization <own test company>` with `--apply` on a local database. The cash-basis rebuild must run.

---

### F14. The pre-commit hook commits every untracked file (Medium)

**The issue today:** `.husky/pre-commit` formats the whole repo, then runs `git add -A`. Every commit therefore picks up every untracked or unrelated file in the folder, which could include `.env` files, scratch notes or half-done work.

**The fix:**

- Add `lint-staged` (a root dev dependency, installed with pnpm 9.15.9 so the lockfile stays in CI's format). It formats only the staged files and re-adds only those.
- Remove the old husky-v4 `"husky"` block in the root `package.json`.

**Test:** with one untracked file and one staged, badly formatted `.ts` file, commit. The staged file is committed formatted, and the untracked file stays out.

---

### F15. The server test suite can't run cleanly as a whole (Medium)

**The issue today.** Four separate problems:

1. **Attachments:** the test asks for the signed link by **id**, but the route expects the **key**, so it gets a 404 (`test/attachments.e2e-spec.ts:21-25`, `Attachments/GetAttachmentPresignedUrl.ts:26-30`).
2. **Inventory cost of sales:** parallel requests open and close the test server under each other, which gives a dropped connection (`ECONNRESET`, `test/inventory-cost-of-sales.e2e-spec.ts:329`). Several other files run requests in parallel the same way.
3. **Warehouses left on:** `inventory-cost-of-sales` turns on multiple warehouses in the **shared** test company (line 213). After that, `credit-edit-ledger` and `imports-exports` fail with `WAREHOUSE_ID_NOT_FOUND`.
4. **Too many connections:** closing the app never closes its database pools: the system pool, the per-company pools and the analytics pools (`Tenancy/TenancyDB/TenancyDB.module.ts:11`, `System/SystemDB/SystemDB.module.ts:38-44`, `Analytics/services/TenantConnectionFactory.ts:15`). One full run in a single process uses up MariaDB's 100 connections. CI only gets by because it splits the suite into 4 parts.

**The fix**

1. The attachments test uses the key.
2. The shared test setup (`test/init-app-test.ts`) starts the server listening once, so requests reuse it.
3. `inventory-cost-of-sales` uses its own company (`createCompany`), as the warehouse tests already do.
4. The app closes all its database pools on shutdown, and the per-company pool cache gets a size limit that closes old pools.

**After:** the full suite passes in one process with a flat connection count, and no test changes another test's company.

**Test:**

- The 4 failing files pass.
- One full `--runInBand` run passes, with `Threads_connected` checked before and after.
- A small e2e test opens and closes the app twice, and the connection count doesn't grow.

---

### F16. Nothing has been checked on Node 18, and CI has never run on this repo (High)

**The issue today**

1. Production and the CI workflows use Node 18.16.1, but all the round-3 checks ran on Node 24, because nvm isn't installed here.
2. GitHub Actions is turned on for the repo, and its workflows are set up for PRs, but it has never run (`gh run list` is empty). On a forked repo, workflows usually have to be enabled once in the Actions tab.

**The fix**

- **D8:** every check in this plan runs on Node 18.16.1 through npx, with nothing installed system-wide.
- **You:** open the repo's Actions tab on GitHub and enable workflows, if GitHub asks. The session will check whether runs then start on the PR.

**After:** the PR is checked on the same Node version as production, both locally and on GitHub.

---

# Part 5: Additions (9 Nov 2026)

Added after the PR was opened, on the same branch and PR, as you asked. Sources:

- the Codex review comment on PR 27 (manual-journal amounts);
- everything the PR and this plan listed as "not fixed" or "not in this plan", except Stripe and Plaid;
- two read-only research passes over the code (9 Nov), which also found F20, F21 and F27.

Same rules as Parts 1–4: one commit per fix, its test in the same commit, then the review loop.

**Decisions taken with the recommended answers** (say if you want any changed). One change from D11 below: the server **does** refuse a transaction on a foreign-currency bank account without a rate (money in/out, categorizing, the matching panel), because nothing imports those.

| #   | Question | Taken |
| --- | --- | --- |
| D10 | **F18:** what should a foreign-currency form start with? | The latest rate when the rate service works; for a payment or refund, the document's own rate when that is all there is; otherwise **empty and required**, never a silent 1 |
| D11 | **F18:** should the server also refuse a foreign document with no rate? | No. The CSV importers rely on the server's `|| 1`; the screens are where rates are typed, so the rule is there |
| D12 | Socket CORS `'*'` | No change. Sign-in is by token, never cookies, so another site gains nothing; changing it could break live updates behind a proxy |
| D13 | Pricing cards (T4) | Not a bug: the pages exist but were never linked. Left for a product decision |

---

## Money and books

### F17. Matching compares amounts in the wrong currency and across bank accounts (High) — Codex review on PR 27

**The issue today**

1. **Codex:** the manual-journal matcher sums the journal's raw debit/credit. A foreign-currency journal on a base-currency bank account (allowed by `validateJournalCurrencyWithAccountsCurrency`) posts each line × rate (`ManualJournalGL.getManualJournalEntry`). So a EUR journal debiting 100 at 1.10 moves USD 110 on the bank, but the matcher accepted a USD 100 line and refused the USD 110 one.
2. **Expenses have the same gap:** the expense credits the bank `totalAmount × rate` (`ExpenseGL.ts:50`), but the matcher compared `totalAmount`.
3. **Expenses and money in/out from any account were offered** (`GetMatchedTransactionsByExpenses.ts`, `GetMatchedTransactionsByCashflow.ts`): matching one from account B marked account A's line as done, though the money never left A in the books.
4. **An expense could be matched twice, or as a draft:** `getMatchedTransaction` for expenses checked neither.
5. **Bank lines from two accounts** matched together all used the first line's account.

**Before:** a USD 100 bank line is matched to the EUR 100 journal; the books show USD 110 left the bank. Or a line on Checking is matched to an expense paid from Savings.

**The fix**

- One helper, `amountInAccountCurrency` / `bankAccountNet` (`BankingMatching/_utils.ts`): a transaction in the account's currency counts its amount; one in another currency counts amount × its rate, per line, as its ledger lines post. Used for the list, the min/max filters, the amount shown and the match check.
- The list and the match load the bank account and pass its id and currency to every matcher.
- Expenses and money in/out are filtered to the bank line's account; an expense must be published and not already matched.
- Bank lines on two accounts are refused: `UNCATEGORIZED_TRANSACTIONS_ACCOUNTS_DIFFER`.

**After:** the EUR 100 journal is offered as USD 110 and matches the USD 110 line only. Savings' expense isn't offered for a Checking line.

**Test:** unit tests for the helpers and the match check; e2e (`round-4-manual-journal-matching`): the Codex example, an expense from another account, a second match of one expense, lines from two accounts.

### F18. Most forms start a foreign-currency rate at 1 (High)

**The issue today**

- **Start at 1 and never fetch a rate:** payment received and payment made (full forms and quick dialogs), refunds of credit notes and vendor credits, bills, vendor credits, expenses, manual journals, money in/out.
- **Sales forms** (invoice, estimate, receipt, credit note) fetch the latest rate only when the user picks a customer, and fall back to `|| 1` when the rate service fails (`withExRateItemEntriesPriceRecalc.tsx:146`). An invoice made from an estimate keeps 1 (`InvoiceFormProvider.tsx:133-135` copies the currency, not the rate).
- **The source rate is thrown away:** the quick dialogs and refund dialogs load the invoice, bill or credit note but copy only its currency (`QuickPaymentReceiveFormDialog/utils.tsx:83-91`, `RefundCreditNoteFormProvider.tsx:67-80`). The refund server even falls back to the credit note's rate, but the screen always sends 1.
- **Every schema is a plain `Yup.number()`,** so nothing stops a save at 1 or empty; money in/out and the vendor form also add `?? 1` on submit.
- **The quick dialogs hide the input** in a popover behind a pencil (`ExchangeRateMutedField`).

**Before:** a 1,000 USD payment in an AED company saved without touching the rate posts the bank at AED 1,000 instead of 3,670, and books a made-up AED 2,670 exchange loss.

**The fix**

1. A shared hook, `useForeignExchangeRate`, for every form above:
   - a base-currency document is always 1;
   - a new foreign document, or a change of currency: the source document's rate when given (payments, refunds), else the latest rate from the server;
   - the fetch fails: the field is left **empty**, never 1;
   - editing keeps the saved rate; it refetches only when the user changes the currency.
2. A shared Yup rule: the rate is required and > 0 when the currency is foreign.
3. The quick dialogs open the rate popover when the rate is empty, so the error is visible.
4. The full payment forms take today's rate (else empty) when the customer or vendor is picked; the quick dialogs and refunds use the document's own rate.
5. The client-side `?? 1` on submit is removed.
6. The server keeps `|| 1` (D11).

**After:** the same payment starts at the invoice's rate (or today's rate), and an empty rate stops the save with "Exchange rate is required".

**Test:** Playwright in an AED company with USD contacts: each form starts at the source or latest rate, or empty and blocks the save; editing keeps the saved rate; a base-currency document stays at 1.

### F19. Categorizing a bank line on a foreign-currency account always posts at 1, with no rate field (High)

**The issue today:** the categorize drawer sends `exchangeRate: '1'` and shows no field (`CategorizeTransactionDrawer/_utils.ts:25,50`). Creating a transaction from the matching panel hard-codes 1 too (`MatchingReconcileTransactionAside/_utils.ts:18`).

**Before:** a USD 500 line on a USD account in an AED company is categorized as an expense; the books show AED 500 instead of 1,835.

**The fix:** both show the rate field when the account is foreign, filled by `useForeignExchangeRate` (latest rate, else empty and required).

**After:** the categorized expense posts AED 1,835 at the rate shown.

**Test:** Playwright for the drawer; server e2e that a categorization with rate 3.67 posts 1,835 on the ledger.

### F20. Money in/out labels the rate the wrong way round (High; same as F1)

**The issue today:** the label reads "1 {base} = x {account currency}" (`MoneyInFormFields`/`MoneyOutFormFields`), but the server books `amount × rate` (`BankTransaction.ts:83`).

**The fix and test:** swap the two props, as in F1; Playwright checks `1 USD = 3.67 AED`.

### F21. The opening-balance dialogs show today's date, and saving moves the opening balance (Medium)

**The issue today:** `transfromCustomertoForm` (`CustomerOpeningBalanceDialog/utils.tsx:50-56`, vendor the same) doesn't pick `openingBalanceAt` or `openingBalanceBranchId`, so the form shows today. The branch is also overwritten with the primary one.

**Before:** an opening balance dated 1 Jan 2026, opened and saved on 9 Nov to fix its amount, moves to 9 Nov in the books.

**The fix:** pick the date and branch; set the primary branch only when there is none.

**Test:** Playwright: reopening shows the saved date; saving keeps it.

---

## Bank matching

### F22. The matching panel's "Pending" total is always shown as USD (Low)

**The issue today:** `MatchingTransaction.tsx:410-415` passes `currency={'USD'}`.

**The fix:** the server returns the bank account's currency with `totalPending`; the panel uses it.

**Test:** e2e for the field; Playwright in an AED company.

### F23. No test for unmatching in a closed period (Low)

**The issue today:** the code is guarded (deleting the match's payment hits the lock), but nothing tests it.

**The fix and test:** e2e: match an invoice, lock the month, unmatch is refused and the payment is kept.

---

## Running the app

### F24. Shutdown hooks are never turned on (Medium)

**The issue today:** `main.ts` never calls `app.enableShutdownHooks()`. On a deploy's SIGTERM, the queue workers, after-commit work and DB pools are not closed or waited for (the F15 shutdown code only runs in tests and the CLI).

**The fix:** turn them on in `main.ts`.

**Test:** start the built server, send SIGTERM, check it logs the pools closing and exits 0.

### F25. One place hard-codes the company database prefix (Medium)

**The issue today:** `TenancyDB.module.ts:20` uses `bigcapital_tenant_`; everything else reads `TENANT_DB_NAME_PERFIX` (`common/config/tenant-database.ts:10`).

**The fix:** read `tenantDatabase.dbNamePrefix` from config.

**Test:** unit test with a different prefix.

### F26. Turning branches on can leave half the work saved (Medium; found 9 Nov)

**The issue today:** `ActivateBranchesFeature.service.ts:64-67` creates the first branch and saves "branches on" **outside** the transaction. If a later step fails, those two stay, the transactions never get their branch, and a retry says "already on".

**The fix:** both run inside the transaction (`trx` added to the branch insert and to `BranchesSettings`).

**Test:** e2e with a failing step: no branch and the setting still off.

### F27. Deleting an account a bank rule assigns to gives a 500 (Low)

**The issue today:** `bank_rules.assign_account_id` (and recognized rows' `assigned_account_id`) have a foreign key to accounts, and nothing checks them before delete.

**The fix:** `DeleteAccount` refuses with `ACCOUNT_USED_BY_BANK_RULES` ("Used by bank rules: …"); the screen shows it.

**Test:** e2e.

---

## Permissions and screens

### F28. A user manager without "View roles" can't invite anyone (Medium)

**The issue today:** `GET /roles` needs Role View (`Roles.controller.ts:107`), but inviting needs User Manage; `RequirePermission` takes one rule only.

**The fix:** `RequirePermission` accepts several rules (any of); `GET /roles` allows Role View **or** User Manage. The route-permission coverage test is updated.

**Test:** e2e: a user manager without Role View gets the roles; a user with neither gets 403.

### F29. Bulk delete gives no reason (Low)

**The issue today:** the validate response only has counts and ids (`common/dtos/BulkDelete.dto.ts`); every validator drops the error.

**The fix:** a shared helper adds `nonDeletableReasons: [{ id, type, message }]`; the dialog shows the first few.

**Test:** e2e for customers and accounts; Playwright for the dialog text.

### F30. The unfinished "categorize as expense" code (Low)

**The issue today:** `CategorizeTransactionAsExpense.ts` creates an expense outside the transaction and marks the line uncategorized; nothing calls it.

**The fix:** delete it and its wiring.

---

## Tooling and tests

### F31. The `.env` `PORT` is read by both the server and the webapp (Low)

**The issue today:** the server listens on `SERVER_PORT ?? PORT`; Vite also uses `PORT` for itself (`vite.config.ts:24`) and proxies to `SERVER_PORT || 3000`. With only `PORT` set, both want the same port and the proxy points elsewhere.

**The fix:** Vite uses `WEBAPP_PORT || 4000` for itself and proxies to `SERVER_PORT || PORT || 3000`.

### F32. E2E tests that depend on shared data (Low)

**The issue today:** the banking specs use bank line, rule or category id 1 and accept `[200, 404]`; 32 specs send `branchId: 1` / `warehouseId: 1`.

**The fix:**
- the banking specs create their own account and bank lines (helpers moved to `test/_utils/`) and assert exact statuses;
- (`branchId: 1` / `warehouseId: 1` left as they are: the server drops them while branches and warehouses are off, and the shared company's first branch and warehouse are id 1.)

**Test:** the suite passes in a brand-new test company.

---

# Part 6: Sweep of the areas never checked

**Areas:** reports (beyond those fixed), form logic in the screens, branches, email and PDF content.

**How:**
- read-only research, at most two agents at a time;
- a finding that puts wrong money in the books, loses data, opens a security gap or crashes a main screen is fixed here, with a test, as `fix: (sweep) …`;
- everything else goes to the PR's "Found in passing" list.

**Done 9 Nov.** Two read-only passes (reports; branches, emails/PDFs and screen forms). Each fix below has a test that fails on the old code.

| # | Found | Fixed |
| --- | --- | --- |
| S1 | Manual journal lines dropped the contact and branch picked in the screen (the cells wrote `contact_id` / `branch_id`) | ✓ |
| S2 | After branches are on, journal lines without their own branch were posted with none | ✓ |
| S3 | An invoice made from an estimate (and a credit note from an invoice) dropped the discount and adjustment, and blanked the number, notes and terms | ✓ |
| S4 | The invoice PDF (and its email attachment) left out the adjustment line; payment emails showed a blank number | ✓ |
| S5 | **Security:** export and report PDFs rendered user text (customer, item, account names) as HTML | ✓ |
| S6 | Invoices, money in/out and vendor-credit refunds could be saved without a branch once branches are on (validators not registered; Save & New dropped the branch) | ✓ |
| R1 | Balance sheet period columns counted entries on the start date twice | ✓ |
| R2 | Transactions by customer/vendor counted start-date entries in the opening and again in the period | ✓ |
| R3 | A/R and A/P aging counted overdue days from today, not the report date | ✓ |
| R4 | Inventory item details valued the opening stock with sales at their selling price | ✓ |
| R5 | Sales / purchases by items counted adjustments, transfers and credits | ✓ |
| R8 | Cash flow period columns from mid-month dropped the opening cash | ✓ |
| R9 | **Report repositories were shared by every request** (and every company): a report could show another request's data | ✓ |
| — | Journal report ignored its default dates; balance summary % divided by 0 | ✓ |

Not fixed (listed in the PR): sales tax liability's "collected" column (needs a decision on what it means), aging as of a past date subtracting later payments, the inventory reports' branch filter, branch activation not filling older document types, deleting a used or primary branch, invoice emails without tax lines, and smaller items.

---

# Not in this plan

- **Stripe** (left out as you asked; not critical for you):
  - foreign-currency payments recorded at rate 1;
  - the hard-coded ngrok address;
  - duplicate notices racing;
  - `account.updated` never activating the integration.
- **Plaid** (left out as you asked): the sync itself was never checked.
- **Checked on 9 Nov and not a problem:**
  - **the settings store keeps a rolled-back value:** it is per request, and the one save inside a transaction belongs to a request that has already failed;
  - **documents replace all their lines on every edit:** bills keep their line ids (landed costs stay linked); other documents' new ids are referenced by nothing that survives the edit;
  - **socket CORS `*`:** see D12.
- **Pricing cards (T4):** see D13.

---

# How every fix will be verified

1. **Prove the bug first:** a test that reproduces it and fails on today's code. If it can't be reproduced, the item is dropped and you'll be told.
2. **Fix it,** then the same test passes.
3. **Edge cases:** foreign currency, locked periods, drafts, and edit and delete as well as create.
4. **Own test companies only:** never `kk@kk.com`. Server e2e runs use `E2E_EMAIL` set to the session's own account.
5. **All checks on Node 18.16.1 (D8), before the PR:**
   - `build:shared`;
   - server and webapp typecheck and build;
   - lint and the format check;
   - all server unit tests;
   - the full server e2e suite, one file at a time, and once in a single process after F15;
   - the Playwright tests for F1 and F12.
6. **Repair commands (F3, F4, F10) and the money repair (F13):**
   - dry run, apply and a second dry run, through the **built** CLI on a local test company;
   - locked periods are skipped;
   - the health check is no worse afterwards;
   - local databases only.
7. **Lockfile:** any change is made with pnpm 9.15.9 and checked with `--frozen-lockfile`.
8. **Final review loop** (see "How the work will run") until clean, then **one PR** to `develop`. The PR lists:
   - each fix, with its commit;
   - anything found and fixed along the way;
   - anything found and not fixed;
   - anything that couldn't be checked.
