import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import { authHeaders } from './_utils/gl';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * CSV import of money with more than 2 decimals (P6): the value is rounded
 * to cents and each rounded value is listed as a warning in the result.
 */
describe('Money — import rounds money to cents (e2e)', () => {
  // The import files are stored under the static folder the server sets
  // up in main.ts; the e2e app needs one too.
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lega-import-'));
    fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
    (global as any).__static_dirname = dir;
  });

  it('imports an opening balance of 100.005 as 100.01 with a warning', async () => {
    const displayName = `Import money ${faker.string.alphanumeric(8)}`;
    const csv = [
      'Customer Type,Display Name,Currency,Opening Balance,Opening Balance At',
      `Business,${displayName},USD,100.005,2026-01-01`,
    ].join('\n');

    const upload = await request(app.getHttpServer())
      .post('/import/file')
      .set(authHeaders())
      .field('resource', 'customers')
      .attach('file', Buffer.from(csv), 'customers.csv')
      .expect(200);
    const importId =
      upload.body.import?.import_id ??
      upload.body.import?.importId ??
      upload.body.import_id ??
      upload.body.importId;
    expect(importId).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/import/${importId}/mapping`)
      .set(authHeaders())
      .send({
        mapping: [
          { from: 'Customer Type', to: 'customerType' },
          { from: 'Display Name', to: 'displayName' },
          { from: 'Currency', to: 'currencyCode' },
          { from: 'Opening Balance', to: 'openingBalance' },
          { from: 'Opening Balance At', to: 'openingBalanceAt' },
        ],
      })
      .expect(200);

    const result = await request(app.getHttpServer())
      .post(`/import/${importId}/import`)
      .set(authHeaders())
      .expect(201);

    const body = result.body;
    expect(body.createdCount ?? body.created_count).toBe(1);
    const warnings = body.warnings ?? [];
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    expect(warning.rowNumber ?? warning.row_number).toBe(1);
    expect(warning.field).toBe('openingBalance');
    expect(warning.value).toBe(100.005);
    expect(warning.roundedValue ?? warning.rounded_value).toBe(100.01);

    const customers = await request(app.getHttpServer())
      .get('/customers')
      .query({ searchKeyword: displayName })
      .set(authHeaders())
      .expect(200);
    const rows = customers.body.customers ?? customers.body.data ?? [];
    const customer = rows.find(
      (row) => (row.displayName ?? row.display_name) === displayName,
    );
    expect(Number(customer.openingBalance ?? customer.opening_balance)).toBe(
      100.01,
    );
  });

  // Codex P1: "abc" and "12,34,567.00" parse to NaN. Rounding NaN gave 0,
  // so the bad rows were imported with a 0 opening balance instead of being
  // rejected.
  it('rejects money cells that are not numbers, instead of importing 0', async () => {
    const tag = faker.string.alphanumeric(8);
    const names = {
      abc: `Import bad abc ${tag}`,
      grouping: `Import bad grouping ${tag}`,
      blank: `Import blank ${tag}`,
      ok: `Import ok ${tag}`,
    };
    const csv = [
      'Customer Type,Display Name,Currency,Opening Balance,Opening Balance At',
      `Business,${names.abc},USD,abc,2026-01-01`,
      `Business,${names.grouping},USD,"12,34,567.00",2026-01-01`,
      `Business,${names.blank},USD,,`,
      `Business,${names.ok},USD,100.005,2026-01-01`,
    ].join('\n');

    const upload = await request(app.getHttpServer())
      .post('/import/file')
      .set(authHeaders())
      .field('resource', 'customers')
      .attach('file', Buffer.from(csv), 'customers.csv')
      .expect(200);
    const importId =
      upload.body.import?.import_id ??
      upload.body.import?.importId ??
      upload.body.import_id ??
      upload.body.importId;

    await request(app.getHttpServer())
      .post(`/import/${importId}/mapping`)
      .set(authHeaders())
      .send({
        mapping: [
          { from: 'Customer Type', to: 'customerType' },
          { from: 'Display Name', to: 'displayName' },
          { from: 'Currency', to: 'currencyCode' },
          { from: 'Opening Balance', to: 'openingBalance' },
          { from: 'Opening Balance At', to: 'openingBalanceAt' },
        ],
      })
      .expect(200);

    const result = await request(app.getHttpServer())
      .post(`/import/${importId}/import`)
      .set(authHeaders())
      .expect(201);
    const body = result.body;

    // The blank and the 100.005 rows import; the two bad rows are errors.
    expect(body.createdCount ?? body.created_count).toBe(2);
    expect(body.errorsCount ?? body.errors_count).toBe(2);
    const errorRows = (body.errors ?? [])
      .map((error) => error.rowNumber ?? error.row_number)
      .sort();
    expect(errorRows).toEqual([1, 2]);
    const warnings = body.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].roundedValue ?? warnings[0].rounded_value).toBe(100.01);

    const customers = await request(app.getHttpServer())
      .get('/customers')
      .query({ searchKeyword: tag, pageSize: 50 })
      .set(authHeaders())
      .expect(200);
    const rows = customers.body.customers ?? customers.body.data ?? [];
    const byName = (name: string) =>
      rows.find((row) => (row.displayName ?? row.display_name) === name);

    expect(byName(names.abc)).toBeUndefined();
    expect(byName(names.grouping)).toBeUndefined();
    const blank = byName(names.blank);
    expect(Number(blank.openingBalance ?? blank.opening_balance ?? 0)).toBe(0);
    const ok = byName(names.ok);
    expect(Number(ok.openingBalance ?? ok.opening_balance)).toBe(100.01);
  });
});
