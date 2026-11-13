# Critical fixes, round 3

Status: **waiting for your approval**. No code has been changed.

Written 7 Nov 2026. Every item was found or re-checked against `origin/develop` at `024d740e4` (after PR 17 and PR 18). It follows [2026-11-01-remaining-fixes.md](2026-11-01-remaining-fixes.md), which is now fully merged (PRs 10–16), plus the follow-ups in PRs 17 and 18.

**Where these came from:**
- Bugs that PRs 10, 11, 13, 15 and 18 found "in passing" but didn't fix.
- A fresh check on 6 Nov of areas the earlier audits didn't cover: deletes and undo, bank matching, framework behaviour, two-company flows, and previews.

**In this plan:** 43 fixes (40 server, 3 screen changes) and 8 new health checks, in 5 work packages run in 3 rounds, with at most two sessions at a time. Each item says:
- **The issue today:** what goes wrong, and where in the code.
- **Before:** an example of what happens now.
- **The fix:** what will change.
- **After:** the same example once fixed.
- **Test:** how the fix is proved.

Items marked **(confirm first)** were found by reading the code but not yet reproduced. The first step for each is a test that shows the bug. If the test shows the code is fine, the item is dropped and you'll be told.

Paths are relative to `packages/server/src/modules/` unless they start with `webapp/`.

---

## Words used below

- **Ledger / books:** the master record of every money movement. All reports are built from it.
- **Handler:** a piece of code that runs when something happens, for example "an invoice is being deleted". There are 646. Some check whether the action is allowed; others write the ledger, stock or balances.
- **Transaction (database):** a group of changes saved all together or not at all. If one step fails, everything is undone.
- **Dry run / preview:** the app does the work inside a transaction and then undoes it, to see whether it would succeed. Bulk delete and import preview work this way. A dry run must leave nothing behind.
- **Matching:** linking a bank-feed line to an existing invoice, bill or payment instead of creating a new entry.
- **Categorizing:** turning a bank-feed line into a new entry (deposit, expense and so on).
- **Landed cost:** adding freight or customs from one bill or expense onto the cost of items on another bill.

---

## Decisions needed from you

Approving the plan means accepting the recommended answers, unless you say otherwise.

| # | Question | Recommended |
|---|---|---|
| D1 | E1 changes how **every** handler reports errors. Some failures that are hidden today will start showing as errors in tests and possibly to users. Each one is either a bug (fixed in this package) or a handler that shouldn't block a save, such as an email (kept non-blocking). | Yes, and Package 1 merges before any other package |
| D2 | Deleting a **written-off** invoice: refuse it ("Cancel the write-off first"), or undo the write-off automatically as part of the delete? | Refuse, the same as invoices with payments |
| D3 | Unmatching a bank line that created a payment when it was matched: delete that payment, or keep it and only unlink? | Delete it. It was only created for the match |
| D4 | Matching a bank line to a foreign-currency invoice or bill: which exchange rate? | The match panel asks for the rate, pre-filled with the latest rate (the M4 provider), or the document's own rate if none is available. Never a silent 1 |
| D5 | Who can give someone the **Admin** role? Today anyone with "Manage users" or "Edit roles" can make themselves an admin in effect. | Only the owner and existing admins can grant Admin or edit the Admin role. Nobody can edit their own role's permissions |
| D6 | Attachments are uploaded as `public-read`. Switch to private and serve them through signed links that expire? This matters on real S3. On the bundled storage they aren't reachable from outside anyway. | Yes, private plus signed links |
| D7 | Landed cost from a **bill**: the screens only allow service lines, while the server only allows inventory lines, so it can't be saved today. Which rule is right? | Service and non-inventory lines (the screens' rule, and the server's own comment), with the books fixed so freight isn't counted in stock twice |
| D8 | Work split, at most two sessions at a time, each with its own branch and PR. Round 1: Packages 1 and 3. Round 2: Packages 2 and 4. Round 3: Package 5. | Yes |
| D9 | Two items need database migrations: Q3 (one stock row per item and warehouse) and S10 (a session version on each login). Q3 merges duplicate rows first. Both have an undo step, and both are run on local databases only until you approve. | Yes |

---

## How the work will be split

At most **two sessions run at the same time**. The screen changes (V1–V3) are done inside the package whose server change needs them, so there is no separate screens package.

| Package | Items | Main area | Branch | Round |
|---|---|---|---|---|
| 1. Errors and transactions | E1–E8 | event handlers, dry runs, import preview, after-save work | `fix/handler-errors-and-dry-runs` | 1 |
| 3. Security | S6–S16, V3, V2 (role messages) | invites, Stripe, sessions, roles, workspaces, attachments | `fix/security-round-3` | 1 |
| 2. Deletes, undo and bank matching | B1–B9, V1, V2 (delete messages) | write-offs, landed cost, bank delete, unmatch, matching FX | `fix/deletes-and-bank-matching` | 2 |
| 4. Warehouses and smaller fixes | Q1–Q12 | multi-warehouse, stock rows, imports, labels | `fix/warehouses-and-small-fixes` | 2 |
| 5. Data health check | H9–H16 | read-only checks for damage already done | `feat/health-check-round-3` | 3 |

**Round 1: Packages 1 and 3, two sessions.**
- Package 1 changes how errors are handled in every handler.
- Package 3 can run alongside it, because its fixes are in services, routes and the sign-in check, not in handler checks.
- They share one file: `UsersModule/subscribers/SyncSystemSendInvite.subscriber.ts`. Package 3 fixes the company ID there; Package 1 may mark it "ignore errors". To keep the merge simple, Package 3 doesn't change any handler's `@OnEvent` options.
- Package 1 merges first. Package 3 then brings its branch up to date with `develop`, re-runs its tests with the new error handling, and merges.

**Round 2: Packages 2 and 4, two sessions.** Both start from `develop` once Package 1 is merged.
- Many fixes in Package 2 are checks that only start working once errors stop the save, so their tests would be wrong without Package 1.
- Package 4 touches warehouse handlers that Package 1 changes.
- The two packages touch different files, so they don't conflict with each other.

**Round 3: Package 5, one session.** The health check goes last, so its checks match the final code.

---

# Package 1: Errors and transactions

### E1. Errors in handlers are ignored, so saves finish half-done (critical, affects the whole server)

**The issue today**
1. The event library (`@nestjs/event-emitter` 2.1.1) catches any error a handler raises. It writes the error to the log and tells the caller "done" (`event-subscribers.loader.js`, `wrapFunctionInTryCatchBlocks`). This is the library's default unless a handler opts out with `{ suppressErrors: false }`.
2. Only 86 of the 646 handlers opt out (the lock checks, cash-basis and branch checks). The other ~560 can't stop a save.
3. **Checks that never block anything:**
   - "can't delete a matched transaction" (`BankingMatching/events/ValidateMatchingOn*Delete.ts`)
   - "can't delete a deposit made from a bank line" (`BankingTransactions/subscribers/PreventDeleteTransactionsOnDelete.ts`)
   - tax rate checks (`TaxRates/subscribers/*TaxRateValidateSubscriber.ts`)
   - every warehouse check (`Warehouses/subscribers/Validators/*`)
   - attachment checks (`Attachments/events/*`)
   - "customer or vendor still has credits" (`CreditNotes/subscribers/DeleteCustomerLinkedCreditSubscriber.ts`, `VendorCredit/subscribers/DeleteVendorAssociatedVendorCredit.ts`)
4. **Writes whose failure is hidden:**
   - the ledger entries of invoices, bills, receipts, payments, expenses, journals, credit notes, vendor credits and landed cost
   - stock movements and tax rows
   - the paid and credited amounts on invoices and bills
   - attachment links

**Before**
1. A 300 payment is matched to a bank deposit. Someone deletes the payment.
2. The check raises "cannot delete, matched". The library logs it, and the delete goes ahead.
3. The bank line still says "matched" to a payment that no longer exists.
4. Or: while an invoice for 1,000 is being saved, the database is busy and the ledger write times out. The user sees "Invoice created", but the books never get the 1,000.

**The fix**
- Change the library's default so errors stop the save. This is a one-line `pnpm patch` of `@nestjs/event-emitter` (`?? true` → `?? false`). It is recorded in `package.json` and applied on every install.
- Go through every handler and sort it into one of two groups:
  - **Part of the save:** it gets the database transaction, or it checks or writes data. It keeps the new default, so an error undoes the whole save.
  - **Side effects after the save:** email, SMS, notifications, analytics, audit log, ClickHouse, Plaid, webhooks, and handlers on events sent after the save has committed. These are marked `{ suppressErrors: true }` explicitly, with a one-line comment saying why.
- Add two automatic checks:
  - A test that fails if a library upgrade brings back the old default.
  - A test that lists every handler, and fails if one that receives a database transaction is marked "ignore errors" without being on a short reviewed list.
- Run the full server test suite. Each new failure is either:
  - a hidden bug: fix it, and list it in the PR; or
  - a handler that belongs in the side-effect group.

**After:** in the same example, deleting the matched payment is refused with "This transaction is matched to a bank line; unmatch it first". A failed ledger write undoes the invoice save, and the user sees an error instead of a half-saved invoice.

**Test:** the two automatic checks above; deleting a matched payment, expense, journal and deposit is refused; a forced failure in the invoice ledger handler leaves no invoice; a forced failure in the invite email still saves the invite.

---

### E2. Dry runs and previews behave as if they were saved

**The issue today**
1. The 16 bulk-delete dry runs (`*/ValidateBulkDelete*.service.ts`) and the import preview (`Import/ImportFilePreview.ts:35-42`) undo their work with `trx.rollback()` and no reason.
2. With no reason given, knex reports the transaction as **finished successfully**. So work scheduled "after the save" runs anyway, such as stock cost recalculation and SMS notices. PR 18 made rollbacks pass on their error, but only in the shared save helper. The dry runs don't use it.

**Before:** you open the bulk-delete dialog for 20 invoices and close it without deleting. A stock cost recalculation is still scheduled for every item on them.

**The fix:** dry runs and the preview undo with a specific "dry run" error and catch it themselves. After-save work only runs for real saves.

**After:** the same dialog schedules nothing.

**Test:** a dry run and an import preview each register an after-save step, which doesn't run.

---

### E3. The accounts bulk-delete dry run disconnects the bank feed for real (critical)

**The issue today**
1. Deleting a bank account that is linked to Plaid tells Plaid to disconnect, **during** the delete, before it is saved (`BankingAccounts/subscribers/DisconnectPlaidItemOnAccountDeleted.ts:56-57`).
2. The bulk-delete dry run triggers the same step (`Accounts/ValidateBulkDeleteAccounts.service.ts:39` → `DeleteAccount.service.ts:87`).

**Before:** you select a linked bank account in the Accounts list and click Bulk delete, then cancel. The database is unchanged, but the bank connection is already revoked. The bank feed stops syncing, while the screen still shows the account as connected.

**The fix:** the Plaid disconnect only runs after a real delete has been saved. With E2, it never runs for a dry run.

**After:** cancelling the dialog leaves the bank feed connected. A real delete disconnects it once the delete is saved.

**Test:** with a fake Plaid client: the dry run makes no Plaid call; a real delete makes one; a real delete that fails afterwards makes none.

---

### E4. Previewing an accounts import creates the accounts for real

**The issue today:** creating an account writes the row **outside** the transaction (`Accounts/CreateAccount.service.ts:141-145`). The import preview undoes the transaction, but the accounts are already saved.

**Before:**
1. You upload a chart of accounts and look at the preview. All 80 accounts now exist.
2. The real import then fails with "account name already exists".
3. If you cancel instead, the 80 accounts stay.

**The fix:** account creation writes inside the transaction. Every other import type was checked and already does this.

**After:** the preview creates nothing. The import creates the 80 accounts once.

**Test:** preview an accounts file: account count unchanged; import: accounts created once.

---

### E5. A failed import preview or import blocks the company until restart

**The issue today**
1. The import preview and the import itself open a transaction, but don't close it when something goes wrong (`Import/ImportFilePreview.ts:35-42`, `Import/ImportFileProcessCommit.ts:41-46`). Examples: the file wasn't mapped, it has expired, or it can't be read.
2. Each company has 7 database connections. Each failure keeps one forever.

**Before:** a user tries to preview a broken file 7 times. Every request for that company then hangs (screens, reports, saves) until the server is restarted.

**The fix:** always close the transaction, whether the step succeeds or fails.

**After:** 20 failed previews in a row, then the company still works normally.

**Test:** fail a preview 10 times, then confirm a normal request still answers.

---

### E6. Workspace totals change after saves that were undone

**The issue today:** each ledger write also queues an update of the totals kept in ClickHouse (used for the totals on the workspace list). It is queued straight away, whether the save is kept or undone (`Ledger/LedgerStorage.service.ts:138, 177`).

**Before:** every dry run, preview or failed save changes the workspace totals. They stay wrong until the nightly 3 AM rebuild.

**The fix:** queue the ClickHouse update only after the save has committed.

**After:** dry runs and failed saves don't change the totals.

**Test:** a dry run queues no ClickHouse job; a real save queues one.

---

### E7. "Cost computing" banner stuck on after an import preview

**The issue today:** the "cost calculation running" flag is set outside the transaction (`InventoryCost/subscribers/InventoryCost.subscriber.ts:61`). In a preview, no cost job runs to clear it again (`:50`).

**Before:** after previewing an invoices import, reports show "cost computing…" indefinitely.

**The fix:** set the flag inside the save, and only when a cost job is actually scheduled.

**After:** the preview leaves the flag off.

**Test:** preview an invoices file; the flag stays off.

---

### E8. Invoice tax lines deleted outside the save

**The issue today**
1. Deleting an invoice sends its "deleted" notice **without** the transaction (`SaleInvoices/commands/DeleteSaleInvoice.service.ts:136-139`). The handler that removes the invoice's tax rows therefore deletes them outside the save (`TaxRates/subscribers/WriteInvoiceTaxTransactionsSubscriber.ts:53-62`).
2. The invoices bulk-delete dry run therefore deletes the tax rows of every invoice in it, for real.
3. A delete refused for another reason (for example a locked period) also loses them.

**Before:** you open the bulk-delete dialog for 10 invoices and cancel. Those invoices now show no tax lines on their detail view and PDF, and they drop out of tax reports built from tax rows. Their totals and ledger still include the tax.

**The fix:** pass the transaction with the notice (bills already do this). Also check the other "…deleted" notices for the same mistake.

**After:** cancelling the dialog leaves the tax lines in place. A refused delete keeps them too.

**Test:** dry run then count tax rows (unchanged); delete refused by a locked period (tax rows unchanged); a real delete (tax rows gone).

---

# Package 2: Deletes, undo and bank matching

### B1. Deleting a written-off invoice leaves the write-off in the books (critical)

**The issue today**
1. When an invoice is deleted, only its own ledger rows (`SaleInvoice`) are undone (`SaleInvoices/subscribers/InvoiceGLEntriesSubscriber.ts:57-63`).
2. The write-off is stored as a separate set (`InvoiceWriteOff`, `commands/writeoff/SaleInvoiceWriteoffGL.ts:41`). It is only undone when the write-off is cancelled.
3. The delete checks block invoices with payments or credits, but not written-off ones (`DeleteSaleInvoice.service.ts:63-80`).

**Before**
1. A 1,000 invoice is written off to Bad Debt, and then deleted.
2. The sale is undone, but the write-off stays: Dr Bad Debt 1,000 / Cr Receivables 1,000.
3. The customer now shows **−1,000** owed (as if we owe them), and Profit & Loss keeps a 1,000 bad-debt expense with no document behind it.

**The fix (D2):** deleting a written-off invoice is refused with "Cancel the write-off first". Bulk delete lists it as "can't be deleted".

**After:** the same delete is refused. Cancel the write-off, then delete: both sets of entries are gone and the customer's balance is back to 0.

**Test:** delete a written-off invoice (refused); cancel then delete (ledger has no rows left for it); bulk delete reports it as not deletable.

---

### B2. Deleting or editing the expense or bill behind a landed cost leaves the cost in stock (critical)

**The issue today**
1. The check "this expense was used for landed cost" is an empty function, because its body is commented out (`Expenses/commands/CommandExpenseValidator.service.ts:87-98`).
2. When an expense is edited, the checks that its landed-cost lines aren't removed or reduced are commented out too (`Expenses/commands/EditExpense.service.ts:74-82`).
3. For bills, only the bill **receiving** the landed cost is protected (`EE/BillLandedCosts/LandedCostsBridge.provider.ts:46-57`). The bill it **came from** can be deleted or reduced freely.

**Before**
1. A 200 freight expense (Dr Freight / Cr Bank) is added onto Bill P's stock. The landed cost posts Dr Stock 200 / Cr Freight 200.
2. The expense is deleted. Its own entries go, but the landed cost stays.
3. Freight is now **−200**, stock is 200 too high, and no money ever left the bank.
4. Reducing the expense line from 200 to 50 instead leaves Freight at −150.

**The fix**
- Restore the expense check: an expense used for landed cost can't be deleted.
- Restore the edit checks: a line used for landed cost can't be removed, or reduced below the amount allocated from it.
- Add the same checks for a **source** bill: delete, and removing or reducing a line.
- The message names the landed cost to remove first.

**After:** deleting the expense is refused with "Used as landed cost on bill B-00012; remove it there first". Reducing the line below 200 is refused. Remove the landed cost first, and both actions work.

**Test:** for an expense source and a bill source: delete, remove line and reduce line are each refused; after removing the landed cost they're allowed, and the ledger is clean.

---

### B3. Deleting a deposit or expense made from a bank line loses it, and the bank line can't be fixed

**The issue today**
1. The check that should stop this only runs when the deposit has `uncategorizedTransactionId` set. Categorizing never sets that field (`BankingTransactions/utils.ts:52-74`), so the check never runs (`BankingTransactions/subscribers/PreventDeleteTransactionsOnDelete.ts:22-38`).
2. The check would crash anyway, because it is set up with the wrong kind of model reference (line 13).
3. **(confirm first)** An expense made from a bank line (`categorizeRefType = 'Expense'`) has no such check at all.

**Before**
1. A 500 bank-feed deposit is categorized as Other Income, and the user deletes the deposit from the Bank transactions list.
2. Its ledger entries go, so the 500 disappears from the bank.
3. The bank line still says "categorized", pointing at nothing. Uncategorizing fails with "transaction not found", so it can never be categorized again.

**The fix:** look up the bank line by the deposit's own ID (`categorizeRefType`/`categorizeRefId`), with the right model reference, and refuse the delete: "Uncategorize the bank line instead". Do the same for expenses made from a bank line. Together with E1, this check now actually blocks.

**After:** the delete is refused. Uncategorizing the line removes the deposit and frees the line.

**Test:** delete a categorized deposit or expense (refused); uncategorize (removed, line free); categorize again (one posting).

---

### B4. Unmatching leaves the payment the match created, so the money is counted twice

**The issue today**
1. Matching a bank line to an invoice or bill creates a payment for it (`BankingMatching/queries/GetMatchedTransactionsByInvoices.service.ts:132-145`, `…ByBills.service.ts:130-142`). The match is stored with type `PaymentReceive` / `BillPayment`.
2. Unmatching only deletes the link (`BankingMatching/commands/UnmatchMatchedTransaction.service.ts:36-39`). The payment stays and still counts.

**Before**
1. A 300 deposit is matched to an invoice, which creates payment PR-1 (bank +300, invoice paid).
2. The user unmatches it. The line goes back to "uncategorized", but PR-1 and the paid invoice stay.
3. The user then categorizes the line as income. The bank now shows **+600** for one 300 deposit.

**The fix (D3):** unmatching a match of type `PaymentReceive` / `BillPayment` also deletes that payment, in the same save. Matches to documents that already existed are only unlinked, as today.

**After:** unmatching removes PR-1, the invoice is unpaid again, and the bank shows 0 until the line is used again.

**Test:** match then unmatch, for an invoice and for a bill: the payment is gone, the invoice is unpaid, and the bank ledger nets to 0. Unmatching a manual journal match leaves the journal.

---

### B5. Matching a bank line to a foreign-currency invoice or bill uses exchange rate 1

**The issue today**
1. The bill match hard-codes rate 1 (`BankingMatching/queries/GetMatchedTransactionsByBills.service.ts:120`).
2. The invoice match passes no rate, and it falls back to 1 (`GetMatchedTransactionsByInvoices.service.ts:117-130`, `PaymentReceived/…/PaymentReceivedDTOTransformer.ts:87`).
3. The M4 fix only covered the "latest rate" lookup, not this path.

**Before:** your base currency is USD. A EUR 1,000 bill was recorded at 1.10, so 1,100 USD is owed. Matching the EUR 1,000 withdrawal pays it at rate 1:
- The bank is credited 1,000 USD instead of 1,100.
- A false exchange gain of 100 is posted.
- The bank's USD balance drifts by 100.

**The fix (D4):** when the bank account or the document isn't in the base currency, the match needs a rate. The match panel shows it, pre-filled with the latest provider rate for the bank line's date (or the document's own rate if the provider has none). The server refuses a foreign match without a rate.

**After:** the same match uses about 1.10 (or the rate you enter). The bank is credited about 1,100 USD, and only a real rate difference is posted.

**Test:** match a foreign invoice and bill with a given rate (correct bank and gain/loss amounts); without a rate (refused); base-currency matches unchanged.

---

### B6. Deleting any account with no bank rules wipes every bank-rule match

**The issue today**
1. When an account is deleted, the app un-does bank-rule suggestions for the rules on that account (`BankingAccounts/subscribers/DeleteUncategorizedTransactionsOnAccountDeleting.ts:42-46`).
2. With no rules, it passes an empty list. An empty list means "no filter", so every suggestion in every bank account is undone (`BankingTranasctionsRegonize/commands/RevertRecognizedTransactions.service.ts:54-62`).

**Before:** you delete an unused "Office plants" expense account. Every bank-rule suggestion across all bank accounts disappears from "For review".

**The fix:** with no rules, do nothing. Also limit the undo to the deleted account's own bank lines.

**After:** the same delete leaves every suggestion in place.

**Test:** with rules on two accounts, delete a third account with no rules: suggestions unchanged. Delete an account with rules: only its suggestions are undone.

---

### B7. Stripe payment fails when the Stripe clearing account has to be created

**The issue today:** when a Stripe payment arrives and the clearing account doesn't exist, it is created inside the save. The deposit-account check then reads **outside** the save, so it can't see the new account (`PaymentReceived/commands/PaymentReceivedValidators.service.ts:344-346`). Normally the account exists already; this happens after it was deleted or the base currency changed.

**Before:** a customer pays an invoice by card. Stripe's notice fails on every retry, and the invoice stays unpaid although the money was taken.

**The fix:** the check reads inside the save.

**After:** the payment is recorded and the invoice shows paid.

**Test:** delete the clearing account, send a signed payment notice: the account is created and the payment recorded.

---

### B8. Bank rules are applied before they're saved

**The issue today:** creating, editing or deleting a bank rule queues the "apply rules to bank lines" job straight away, before the rule is saved (`BankingTranasctionsRegonize/events/TriggerRecognizedTransactions.ts:42, 78, 100`). If the job runs quickly:
- it may not see the new rule; or
- on an edit, it removes the old suggestions and then re-applies the **old** rule.

**Before:** you change a rule from "contains AMAZON" to "contains AWS". The "For review" list still shows the old Amazon suggestions.

**The fix:** queue the job only after the rule is saved.

**After:** the list shows the AWS suggestions.

**Test:** create and edit a rule with the queue running at once; suggestions follow the saved rule.

---

### B9. Deleting an account goes ahead when deleting its bank rules failed

**The issue today:** deleting an account first deletes its bank rules, but failures in that step are ignored (`BankRules/commands/DeleteBankRules.service.ts:22`).

**Before:** a rule fails to delete. The account is deleted anyway, leaving a rule that points at a missing account.

**The fix:** a failure stops the delete.

**After:** the delete is refused, and nothing is removed.

**Test:** a forced rule-delete failure refuses the account delete.

---

# Package 3: Security

### S6. Invites put people into the wrong company, which can plant a hidden member (critical)

**The issue today**
1. An invite is recorded against the inviter's **sign-up** company (`authorizedUser.tenantId`), not the company they are inviting from (`UsersModule/subscribers/SyncSystemSendInvite.subscriber.ts:41`, and resend at `:91`).
2. Accepting it adds a membership to that company (`UsersModule/commands/AcceptInviteUser.service.ts:95-105`), but no user record inside it.

**Before**
1. Mallory is invited to your company A as a Viewer, so A is her "sign-up" company.
2. She creates her own company M and, from M, invites `sock@evil` as an admin.
3. `sock@evil` accepts, and lands in **your company A**.
4. A's Users page doesn't show them, so nobody can remove or deactivate them. They can read:
   - every user's email
   - settings
   - all customers and vendors
5. They keep access after Mallory is removed.

Normal use breaks too: an admin who created a second company sends every invitee into their first one.

**The fix**
- Use the current company (`tenancyContext.getTenant()`) for invites and resends.
- Accepting an invite also creates the user record in that company if it's missing.
- Package 5 (H9) lists existing memberships with no user record, so you can remove them.

**After:** the same invite lands in M. Company A is untouched.

**Test:** a user whose sign-up company is A invites from company M: the invite and membership are in M, and A is unchanged. Resend does the same.

---

### S7. The Stripe payment notice trusts the company and invoice written into the payment (confirm first)

**The issue today**
1. When Stripe reports a completed checkout, the app reads the company and invoice from the payment's own notes (`metadata.tenantId`, `metadata.saleInvoiceId`). It then records a payment of the full amount (`StripePayment/subscribers/StripeWebhooksSubscriber.ts:42-73`).
2. It doesn't check that the Stripe account that took the money is the one connected to that company. It also doesn't check that the checkout came from that invoice's payment link.
3. Each company connects its own Stripe account and can create checkouts with any notes it likes.

**Before:** another company creates a checkout on its own Stripe account, with notes naming your company and invoice 41. It pays and then refunds itself. Your invoice 41 is marked paid, with a payment in your books.

**The fix:** accept the notice only if:
- the Stripe account on the event (`event.account`) is the one connected to that company;
- the checkout ID was created by that invoice's payment link; and
- the currency matches.

Otherwise log it and ignore it.

**After:** the forged checkout is ignored, and invoice 41 stays unpaid. A real customer payment is recorded as before.

**Test:** signed events with the wrong account, an unknown checkout or the wrong currency (ignored); a correct event (recorded).

---

### S8. Connecting Stripe can be hijacked to link someone else's Stripe account

**The issue today:** the Stripe connect link has no `state` value (`StripePayment/GetStripeAuthorizationLink.ts:12`). The return page sends whatever `code` is in its address to the server as soon as it loads (`webapp/…/PreferencesStripeCallback.tsx:14-20`).

**Before:** an attacker sends an admin a link to the return page carrying the attacker's own code. The admin opens it, and the attacker's Stripe account is now connected to your company. If staff turn it on for invoices, customer card payments go to the attacker.

**The fix:** create a one-time `state` tied to the user and company when the link is made. Check it on return, and refuse a missing or wrong state.

**After:** the attacker's link is refused with "This Stripe connection wasn't started from your account".

**Test:** callback with no state, a wrong state, or another user's state (refused); the normal flow works.

---

### S9. The workspace list shows balance totals to people who shouldn't see them

**The issue today:** the workspace list returns total assets and liabilities for every company you belong to. That includes companies where you are deactivated, or have no permission to see reports (`EE/Workspaces/queries/GetWorkspaces.service.ts:56-122`).

**Before:** a Viewer with no report access, or a deactivated user, sees the company's total assets on the workspace list.

**The fix:** show totals only where you are active and can see the balance sheet. Show nothing otherwise.

**After:** the same user sees the company's name, but no figures.

**Test:** deactivated user and no-report user (no totals); admin (totals).

---

### S10. Sessions keep working after a password reset

**The issue today:** a sign-in session lasts up to 30 days. Resetting or changing the password doesn't end existing sessions (`Auth/AuthResetPassword.service.ts`; the session check only confirms the user exists).

**Before:** someone has stolen a session (for example from a shared computer). The owner resets their password, but the thief stays signed in for up to 30 days.

**The fix:** add a "session version" to each login (D9 migration). Sessions carry it. A password reset or change increases it, which ends all older sessions.

**After:** the stolen session is refused on its next request, and the owner's new sign-in works.

**Test:** reset the password, then make a request with an old session (refused) and a new sign-in (works).

---

### S11. "Manage users" or "Edit roles" can make someone an admin in effect

**The issue today**
1. Inviting or editing a user accepts any role, including Admin (`UsersModule/commands/EditUser.service.ts:66-99`, `InviteUser.service.ts:50-68`).
2. Editing a role has no limits either, so you can tick every permission on your own role (`Roles/commands/EditRole.service.ts:27-48`).

**Before:** a user who can only manage users invites a second email they own as Admin. Or a user who can edit roles turns on every permission for their own role.

**The fix (D5):** only the owner and admins can give the Admin role or edit it. Nobody can change the permissions of their own role.

**After:** both attempts are refused with "Only an admin can do this".

**Test:** a non-admin with "Manage users" inviting as Admin (refused) or as Viewer (allowed); editing your own role (refused).

---

### S12. Attachments are uploaded as public files

**The issue today:** attachments are stored with `public-read` (`Attachments/Attachment.module.ts:87-92`). On real S3, anyone who has a file's address can download it, even after their access is removed. The address can't be guessed, but it can leak through browser history or shared links.

**The fix (D6):** store files as private. The download route checks access, then returns a link that expires after a few minutes.

**After:** an old file address no longer opens. Downloads from the app still work.

**Test:** upload, download through the app (works), open the stored address directly (refused).

---

### S13. Live-update connections need no sign-in

**The issue today:** the live-update socket accepts anyone, from any site, and sends every company's events to everyone (`Socket/Socket.gateway.ts`). The events carry no data, but they show when other companies are active.

**The fix:** require a signed-in session to connect, and only send each company's events to its own members.

**After:** a connection without a session is refused. Members still get their own updates.

**Test:** connect without a session (refused); with a session, you get your own company's events only.

---

### S14. Print files are briefly readable by anyone

**The issue today:** while a PDF is being made, its HTML is written to `public/pdf/document-print-<time>.html`, which anyone can read and whose name is easy to guess (`ChromiumlyHtmlConvert.service.ts:28`). This only matters if the server port is reachable directly.

**The fix:** write to a private temporary folder with a random name, and delete it afterwards.

**After:** nothing is written to the public folder.

**Test:** make a PDF; no file appears under `public/pdf`.

---

### S15. Anyone can poll any company's setup job

**The issue today:** `GET /workspaces/build/:id` returns the status of any setup job by its number.

**The fix:** only the user who started the job can read it.

**After:** another user gets "not found".

**Test:** the creator sees the status; another user gets 404.

---

### S16. Lemon Squeezy checkout never sends the user back to the app

**The issue today:** checkout reads `lemonSqueezy.redirectTo`, but the setting is registered as `lemonsqueezy` and has no `redirectTo` (`Subscription/queries/GetLemonSqueezyCheckout.service.ts:44`).

**The fix:** add the setting (default: the app's billing page) and read it under the right name.

**After:** after paying, the customer comes back to the billing page.

**Test:** the checkout request includes the redirect address.

---

# Package 4: Warehouses and smaller fixes

### Q1. Turning on multiple warehouses can stop halfway, with no way to retry

**The issue today**
1. Turning the feature on creates the first warehouse in its own save. Then, outside any save and without waiting, it marks the feature as on (`Warehouses/commands/ActivateWarehouses.service.ts:49-52`).
2. The steps that link existing invoices, bills, receipts, credit notes, estimates and stock to the first warehouse all run outside the save (`Warehouses/Activate/*.ts`, `UpdateInventoryTransactionsWithWarehouse.ts:19`, `ActivateWarehousesSubscriber.ts:37`).
3. If any step fails, the feature is on but only some records are linked. Turning it on again is refused ("already active").

**Before:** a company with 5,000 invoices turns on warehouses and one step fails. Stock per warehouse is wrong for good, and the action can't be repeated.

**The fix:** run everything in one save, waiting for each step. If anything fails, nothing changes, and the feature stays off.

**After:** a failure leaves the feature off with nothing changed, so you can try again. Success links every record.

**Test:** a forced failure in one step (nothing changed, feature off); a normal run (every record linked, per-warehouse stock equals total stock).

---

### Q2. The warehouse check never fails

**The issue today:** the check that a warehouse exists doesn't wait for the database, so it always passes (`Warehouses/Integrations/ValidateWarehouseExistance.ts:42`).

**Before:** saving with a warehouse that doesn't exist gives a raw 500 error from the database instead of a clear message.

**The fix:** wait for the lookup.

**After:** "Warehouse not found" (400).

**Test:** save with an unknown warehouse; you get a 400 with that message.

---

### Q3. One item can get two stock rows for the same warehouse

**The issue today:** nothing stops two rows for the same item and warehouse in `items_warehouses_quantity` (migration `20220125021920`). The first stock movement reads, then inserts (`WarehousesItemsQuantitySync.ts:73-93`). Two movements at the same moment both insert, and every later change updates both rows.

**Before:** two invoices for a new item are saved at the same second. The item's warehouse tab shows double the stock from then on.

**The fix (D9):** a migration merges duplicate rows and adds a unique rule on (item, warehouse). The first movement uses "insert, or add to the existing row" in one step.

**After:** the same two saves give one row with the right quantity.

**Test:** two first movements at once give one row; the migration merges an existing duplicate.

---

### Q4. Customer and vendor edits are saved even if the rest of the edit fails

**The issue today:** editing a customer or vendor writes the change outside the save (`Customers/commands/EditCustomer.service.ts:61-65`, `Vendors/commands/EditVendor.service.ts:51-55`).

**The fix:** write inside the save.

**After:** a failed edit changes nothing.

**Test:** a forced failure after the write leaves the contact unchanged.

---

### Q5. Activating an account writes its audit-log entry too late

**The issue today:** activating an account sends its notice without waiting (`Accounts/ActivateAccount.service.ts:56`). The audit-log entry is then written after the save has closed, and fails.

**The fix:** wait for it.

**After:** the audit log shows the activation.

**Test:** activate an account; the audit-log entry exists.

---

### Q6. Tax rows are rewritten in an order that isn't guaranteed

**The issue today:** removing and rewriting a document's tax rows run at the same time (`TaxRates/WriteTaxTransactionsItemEntries.ts:73`). Today the removal happens to run first. If it ever ran second, it would delete the new rows.

**The fix:** remove, then write, one after the other.

**After:** the same result, guaranteed.

**Test:** editing an invoice's tax keeps exactly the new tax rows.

---

### Q7. A warehouse transfer cost sent as a number is refused

**The issue today:** the transfer's `cost` field only accepts text (`WarehousesTransfers/dtos/WarehouseTransfer.dto.ts:37-39`). The webapp doesn't send it, so only API users are affected.

**The fix:** accept a number of zero or more.

**After:** `cost: 12.5` is accepted.

**Test:** an API transfer with a numeric cost is accepted.

---

### Q8. The credit note import sample is empty

**The issue today:** the credit note sample returns no rows or columns (`CreditNotes/commands/CreditNotesImportable.ts:42-44`).

**The fix:** give it a sample row with every column, like the invoice sample.

**After:** the downloaded sample has headers and one example row, and it imports cleanly.

**Test:** download the sample and import it; one credit note is created.

---

### Q9. Bill landed cost can't be saved (D7)

**The issue today**
1. The screens only allow landed cost on service and non-inventory lines (`webapp/src/containers/Entries/utils.tsx:119`).
2. The server only allows inventory lines (`EE/BillLandedCosts/LandedCostsBridge.provider.ts:74-83`), although its own comment says the opposite (`Bills/commands/BillsValidators.service.ts:119`).
3. So nothing can be saved from the screens. Through the API, an inventory freight line puts the freight into stock twice (on the freight item and on the target item) and takes it off cost of sales.

**The fix (D7):** the server follows the screens' rule. The freight line goes to its expense account. Allocation then moves it from that account into the target items' stock, so it is counted once.

**After:** a 200 freight bill on a service line can be allocated from the screens. Stock goes up by 200 once, and the freight expense ends at 0.

**Test:** create a freight bill on a service line, allocate it, and check stock, the freight account and cost of sales. An inventory line is refused with a clear message.

---

### Q10. Opening-balance exchange rate shown the wrong way round

**The issue today:** the customer and vendor opening-balance dialogs label the rate in the reverse direction. For a USD vendor at 3.67 on an AED company, they show "1 AED = 3.67 USD" (`webapp/…/VendorOpeningBalanceFormFields.tsx:75-76`, `CustomerOpeningBalanceFields.tsx:77-78`). The stored rate is right; only the label is wrong. Someone who "corrects" it to 0.27 would post a wrong balance.

**The fix:** swap the label, as the vendor form already does.

**After:** "1 USD = 3.67 AED".

**Test:** in the browser, both dialogs show the right direction.

---

### Q11. Switching to a company where you're deactivated logs you out

**The issue today:** the workspace switcher lists companies where you are deactivated. Picking one gets a 401, and the app logs you out (`webapp/src/hooks/useApiFetcherOnError.tsx:26-29`).

**The fix:** the workspace list marks those companies, and the switcher shows them greyed out with "Your access was deactivated".

**After:** you can't pick the company, and you stay signed in.

**Test:** in the browser, the deactivated company is greyed out and other companies still switch.

---

### Q12. Two existing-data gaps left by PRs 14 and 17

**The issue today**
- Credit notes edited before PR 14 still have their old ledger entries.
- Foreign opening-balance payments saved before PR 17 have no exchange gain/loss line.

Both are corrected only when someone re-saves the record.

**The fix:** add an opt-in repair command (`tenants:repair-stale-journals --dry-run`). It lists these records and, if asked, rewrites their ledger entries, skipping locked periods. It never runs automatically.

**After:** a dry run lists them; a real run rewrites them, and the health check is clean for them.

**Test:** create one of each the old way: the dry run lists both, and a real run fixes them.

---

# Screen changes (done inside Packages 2 and 3)

These are the webapp changes the server fixes need. Each one is done in the same package and PR as its server change.

| # | Screen | Change | For | Done in |
|---|---|---|---|---|
| V1 | Bank match panel | Shows and asks for the exchange rate when the bank account or the document is in another currency | B5 | Package 2 |
| V2 | Error messages | Clear messages for the new refusals: matched transaction, written-off invoice, landed cost source, bank-line deposit (Package 2); admin-only role change (Package 3) | E1, B1–B3, S11 | Packages 2 and 3 |
| V3 | Stripe connect, users and roles | Sends and checks the `state`; hides "Admin" in the role picker for non-admins | S8, S11 | Package 3 |

**Test:** browser tests for V1 and V3; V2 is checked by hand for each message.

---

# Package 5: Data health check

These are new read-only sections in `tenants:money-health-check`. They list records and **change nothing**.

| # | Check | Finds damage from | Example of what it lists |
|---|---|---|---|
| H9 | Company memberships with no user in that company | S6 | "sock@evil is a member of A but not a user there" |
| H10 | Write-off entries whose invoice no longer exists | B1 | "Write-off of 1,000 for deleted invoice #312" |
| H11 | Landed costs whose source expense or bill is gone or smaller than the allocation | B2 | "LC #18: 200 from expense #77, which no longer exists" |
| H12 | Bank lines categorized or matched to a record that no longer exists | B3, B4, E1 | "Bank line 25 Feb, 500: categorized to deposit #90, which was deleted" |
| H13 | Published documents with no ledger entries, or whose entries don't add up to the document | E1, PR 14 | "INV-00412, 1,000: no ledger entries" |
| H14 | Invoices whose tax rows don't match their tax amount | E8 | "INV-00388: tax 150, tax rows 0" |
| H15 | Payments created by matching a foreign document at rate 1 | B5 | "PAY-00051, EUR 1,000 at rate 1 (base USD)" |
| H16 | Duplicate stock rows per item and warehouse | Q3 | "Chair / Main: 2 rows". This also tells us whether the Q3 migration has anything to merge |

What can't be listed reliably: accounts created by an import preview (E4) look like normal accounts, and payments left behind by an unmatch (B4) look like normal payments. H12 shows bank lines that may be involved.

**Test:** create one bad record of each kind in a test company, check it is listed, and check a clean company shows "none".

---

# Not in this plan

- **A fresh sweep of areas not yet checked:** report calculations beyond those already fixed, form logic in the screens, branches, the Plaid sync itself, and email and PDF content. Suggest one round after this plan is merged.
- **Pricing cards (T4)** are still not shown on any page.

---

# How every fix will be verified

1. **Prove the bug first:** write a test that reproduces it and fails on today's code. For "(confirm first)" items, if it can't be reproduced, the item is dropped and you'll be told.
2. **Fix it,** then the same test passes.
3. **Edge cases:** zero amounts, foreign currency, locked periods, drafts, and edit and delete as well as create.
4. **Server tests:** unit tests next to the code, and end-to-end tests under `packages/server/test`. Each package uses its own test companies, not the shared `kk@kk.com` company, so suites don't break each other.
5. **Browser tests:** Playwright for V1, V3, Q10 and Q11.
6. **At the end of each package:**
   - the full server test suite, plus webapp typecheck, build and lint;
   - debits equal credits;
   - Trial Balance, Balance Sheet and Profit & Loss agree before and after on sample data;
   - the existing health check is no worse.
7. **Package 1 extra:** every test that starts failing once errors stop the save is listed in the PR, with whether it was a hidden bug (fixed) or a handler moved to the side-effect group.
8. **One pull request per package** to `develop`, with a short report of what was tested and anything that couldn't be checked.
9. **Migrations (Q3, S10)** are run on local databases only, and you're told before they run anywhere else.

**Order (at most two sessions at a time):**
1. **Round 1:** Packages 1 and 3. Package 1 merges first; Package 3 then updates from `develop`, re-tests and merges.
2. **Round 2:** Packages 2 and 4, both from `develop` after round 1.
3. **Round 3:** Package 5 (health check).
