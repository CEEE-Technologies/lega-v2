# Standalone QBO Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the approved standalone browser-authenticated QBO extraction CLI and portable bundle reader.

**Architecture:** A Node 18 TypeScript workspace package owns OAuth, encrypted local connection state, QBO reads, and atomic paginated bundles. The CLI composes these modules without booting lega-v2 services. Tests use Node's test runner and synthetic HTTP fixtures.

**Tech Stack:** TypeScript, Node built-ins, dotenv for canonical root environment loading, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-25-standalone-qbo-import-design.md` (approved by user).

## Global Constraints

- Node 18 compatible; no lega-v2 services or original LEGA checkout required.
- Preserve QBO fields and IDs; never write tenant or QBO accounting data.
- Secrets stay outside bundles and logs; private state files and encrypted tokens.
- Existing uncommitted application/branding changes must be preserved.
- User explicitly authorized implementation; proceed in this checkout without another plan approval or worktree consent round. No commit/push is part of this request.

## Review Focus

- Unexpected/malformed API responses must fail rather than silently appear empty.
- A crash between page persistence and cursor persistence must resume without duplicates.
- Malicious manifest paths and symlinks must not read outside the bundle.
- Invalid OAuth callbacks must not consume a valid pending authorization.
- Concurrent CLI commands must not overwrite connection tokens or bundle cursors.

### Task 1: Bundle persistence and offline reader

**Files:** `packages/qbo-import/{package.json,tsconfig.json,src/types.ts,src/storage.ts,src/bundle.ts,test/bundle.test.ts}`.

**Interfaces:** `atomicJson(path, value)`, `withLock(path, fn)`, `createBundle(out, source)`, `validateBundle(out, {allowIncomplete?})`, `readEntity(out, entity)`; exported typed manifest version 1.

- [x] Write tests for manifest creation, raw field preservation, page checksums/counts, incomplete rejection, duplicate IDs, corruption, path escape/symlinks, and active/stale locks. Run and observe failure.
- [x] Implement private atomic files, process locks with local dead-process recovery, complete schema/coverage validation, and async entity reader.
- [x] Run `pnpm --filter @lega/qbo-import test`; expected bundle tests pass.

### Task 2: QBO client and report planning

**Files:** `src/client.ts`, `src/catalog.ts`, `src/reports.ts`, `test/client.test.ts`, `test/reports.test.ts`.

**Interfaces:** `QboClient.get/queryPage/companyInfo/preferences/report`, `ENTITY_SPECS`, `planReports`.

- [x] Test API faults/malformed responses, paging queries, refresh once, bounded retry, timeout, secret redaction, fiscal year boundaries/leap years and inventory report parameters. Observe failing tests.
- [x] Implement strict JSON response checks, documented optional resources, pinned minor version, timeouts/retries, and fiscal report plan.
- [x] Run package tests; expected all pass.

### Task 3: OAuth and connection state

**Files:** `src/config.ts`, `src/auth.ts`, `src/prompt.ts`, `test/auth.test.ts`.

**Interfaces:** `loadConfig()`, `ConnectionStore.connect/complete/status/client/disconnect`, temporary browser callback orchestration.

- [x] Test state/expiry/replay, invalid callback recovery, realm binding, encrypted token persistence, refresh rotation, concurrent writers, endpoint origin validation and redaction. Observe failure.
- [x] Implement browser sign-in, hidden manual callback prompt for production, encrypted state, token refresh and revoke under process locks.
- [x] Run package tests; expected all pass.

### Task 4: Extraction and CLI integration

**Files:** `src/extract.ts`, `src/cli.ts`, `src/index.ts`, `test/extract.test.ts`, `test/cli.test.ts`, package README; root scripts, `.env.example`, `.gitignore`, lockfile.

**Interfaces:** `extractBundle({out, client, source, resume, reportDate, onProgress})`; commands `connect`, `extract`, `resume`, `status`, `validate`, `disconnect`.

- [x] Test multi-page extraction, interrupted HTTP failure/resume and uncommitted page recovery, realm mismatch, optional versus required errors, report failure/resume, offline CLI validation/help/errors and duplicate writer rejection. Observe failure.
- [x] Implement extraction and commands, root integration, source coverage summaries, setup and later-import contract documentation.
- [x] Run full package tests, typecheck, build and root-command smoke tests; expected all pass. Verify on Node 18 and report real-QBO authorization separately.
- [x] Request one fresh code review, address material findings with regression tests, and leave all changes reviewable in the current checkout.

## Verification result

Implemented in the current checkout without touching unrelated application changes. All 32 package tests passed on Node 18.20.8, including extraction against a fake QBO HTTP server, real loopback OAuth callbacks, failure/resume, report validation and writer-lock aliases. Node 18 build, package typecheck, formatting, frozen-lockfile validation, git diff whitespace checks and root CLI help smoke test passed. Fresh independent review findings were fixed with regression tests. Real QBO authorization was not attempted; it requires operator app credentials and browser sign-in.
