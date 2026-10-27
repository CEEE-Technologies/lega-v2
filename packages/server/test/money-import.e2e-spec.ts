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
    expect(warning.rowNumber ?? warning.row_number).toBe(2);
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
});
