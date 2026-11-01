import request = require('supertest');
import { faker } from '@faker-js/faker';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createVendor,
  getBaseCurrency,
} from './_utils/gl';

/**
 * F1 / F2: every import, export and print the webapp offers works.
 * The resource names below are the ones the webapp sends.
 */

// The resource names are read from the webapp's source, so a page that
// sends a name the server doesn't know (e.g. "payment_receive") fails here.
const WEBAPP_SRC = path.resolve(__dirname, '../../webapp/src');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const matchesIn = (files: string[], pattern: RegExp) =>
  Array.from(
    new Set(
      files.flatMap((file) =>
        Array.from(fs.readFileSync(file, 'utf8').matchAll(pattern)).map(
          (match) => match[1],
        ),
      ),
    ),
  ).sort();

const webappFiles = sourceFiles(path.join(WEBAPP_SRC, 'containers'));

// The export dialog's list and the list pages' "Export" buttons.
const WEBAPP_EXPORT_RESOURCES = Array.from(
  new Set([
    ...matchesIn(
      webappFiles,
      /DialogsName\.Export,\s*\{\s*resource:\s*'([^']+)'/g,
    ),
    ...matchesIn(
      [path.join(WEBAPP_SRC, 'containers/Dialogs/ExportDialog/constants.ts')],
      /value:\s*'([^']+)'/g,
    ),
  ]),
).sort();

// The list pages' "Print" buttons (`downloadExportPdf({ resource })`).
const WEBAPP_PRINT_RESOURCES = matchesIn(
  webappFiles,
  /downloadExportPdf\(\{\s*resource:\s*'([^']+)'/g,
);

// The import pages' `resource` props.
const WEBAPP_IMPORT_RESOURCES = matchesIn(
  webappFiles.filter((file) => /Import/.test(path.basename(file))),
  /resource=\{'([^']+)'\}/g,
);

const http = () => request(app.getHttpServer());

/** First array in a list response (`bills`, `data`, `sale_receipts`…). */
const rowsOf = (body: any): any[] => {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  const found = Object.values(body || {}).find((value) => Array.isArray(value));
  return (found as any[]) || [];
};

const csvLines = (text: string) =>
  text.split(/\r?\n/).filter((line) => line.trim().length > 0);

/** Uploads a CSV, maps its columns and returns the import id. */
const uploadAndMap = async (
  resource: string,
  csv: string,
  mapping: Array<{ from: string; to: string; group?: string }>,
) => {
  const upload = await http()
    .post('/import/file')
    .set(authHeaders())
    .field('resource', resource)
    .attach('file', Buffer.from(csv), `${resource}.csv`)
    .expect(200);
  const importId =
    upload.body.import?.import_id ??
    upload.body.import?.importId ??
    upload.body.import_id ??
    upload.body.importId;
  expect(importId).toBeTruthy();

  await http()
    .post(`/import/${importId}/mapping`)
    .set(authHeaders())
    .send({ mapping })
    .expect(200);

  return importId as string;
};

const createdCount = (body: any) => body.createdCount ?? body.created_count;
const errorsCount = (body: any) => body.errorsCount ?? body.errors_count;

/** Preview, then import, and check both report the rows as created. */
const previewAndImport = async (importId: string, expected: number) => {
  const preview = await http()
    .get(`/import/${importId}/preview`)
    .set(authHeaders())
    .expect(200);
  expect(errorsCount(preview.body)).toBe(0);
  expect(createdCount(preview.body)).toBe(expected);

  const result = await http()
    .post(`/import/${importId}/import`)
    .set(authHeaders())
    .expect(201);
  expect(errorsCount(result.body)).toBe(0);
  expect(createdCount(result.body)).toBe(expected);
};

describe('Imports, exports and print (e2e)', () => {
  it('finds the webapp resource names', () => {
    expect(WEBAPP_EXPORT_RESOURCES.length).toBeGreaterThanOrEqual(16);
    expect(WEBAPP_PRINT_RESOURCES.length).toBeGreaterThanOrEqual(14);
    expect(WEBAPP_IMPORT_RESOURCES.length).toBeGreaterThanOrEqual(17);
  });

  let tag: string;
  let customerName: string;
  let vendorName: string;
  let itemName: string;

  beforeAll(async () => {
    // Import files and print PDFs are written under the folders main.ts
    // sets up; the e2e app needs them too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lega-import-'));
    fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pdf'), { recursive: true });
    (global as any).__static_dirname = dir;
    (global as any).__public_dirname = dir;

    await cancelTransactionsLock();
    tag = faker.string.alphanumeric(8).toUpperCase();
    const currency = await getBaseCurrency();

    const customerId = await createCustomer(currency);
    const vendorId = await createVendor(currency);
    const itemId = await createServiceItem();

    customerName = (
      await http().get(`/customers/${customerId}`).set(authHeaders())
    ).body.display_name;
    vendorName = (await http().get(`/vendors/${vendorId}`).set(authHeaders()))
      .body.display_name;
    itemName = (await http().get(`/items/${itemId}`).set(authHeaders())).body
      .name;

    // One payment received, so its export and print have a row.
    const invoice = await http()
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate: '2026-01-10',
        dueDate: '2026-02-10',
        invoiceNo: `INV-${tag}`,
        delivered: true,
        entries: [{ index: 1, itemId, quantity: 1, rate: 500 }],
      })
      .expect(201);
    await http()
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate: '2026-01-11',
        depositAccountId: 1000,
        paymentReceiveNo: `PAY-${tag}`,
        entries: [{ index: 1, invoiceId: invoice.body.id, paymentAmount: 200 }],
      })
      .expect(201);
  });

  describe('F1: sample sheets download for every import page', () => {
    it.each(WEBAPP_IMPORT_RESOURCES)('%s sample', async (resource) => {
      const res = await http()
        .get('/import/sample')
        .query({ resource, format: 'csv' })
        .set(authHeaders())
        .expect(200);
      // Credit notes have no sample rows yet (an empty sheet, not an error).
      if (resource !== 'credit_note') {
        expect(csvLines(res.text).length).toBeGreaterThan(1);
      }
    });
  });

  describe('F1: bills, receipts and tax rates import', () => {
    it('imports a bill', async () => {
      const billNo = `IMP-B-${tag}`;
      const csv = [
        'Bill No.,Date,Due Date,Vendor,Open,Item,Quantity,Rate',
        `${billNo},2026-01-05,2026-02-05,${vendorName},T,${itemName},2,150`,
      ].join('\n');
      const importId = await uploadAndMap('bills', csv, [
        { from: 'Bill No.', to: 'billNumber' },
        { from: 'Date', to: 'billDate' },
        { from: 'Due Date', to: 'dueDate' },
        { from: 'Vendor', to: 'vendorId' },
        { from: 'Open', to: 'open' },
        { from: 'Item', to: 'itemId', group: 'entries' },
        { from: 'Quantity', to: 'quantity', group: 'entries' },
        { from: 'Rate', to: 'rate', group: 'entries' },
      ]);
      await previewAndImport(importId, 1);

      const list = await http()
        .get('/bills')
        .query({ searchKeyword: billNo })
        .set(authHeaders())
        .expect(200);
      const bill = rowsOf(list.body).find(
        (row) => (row.bill_number ?? row.billNumber) === billNo,
      );
      expect(bill).toBeDefined();
      expect(Number(bill.total ?? bill.amount)).toBe(300);
    });

    it('imports a sale receipt', async () => {
      const receiptNo = `IMP-R-${tag}`;
      const csv = [
        'Receipt Date,Customer,Deposit Account,Receipt Number,Closed,Item,Quantity,Rate',
        `2026-01-06,${customerName},Petty Cash,${receiptNo},T,${itemName},3,40`,
      ].join('\n');
      const importId = await uploadAndMap('sale_receipt', csv, [
        { from: 'Receipt Date', to: 'receiptDate' },
        { from: 'Customer', to: 'customerId' },
        { from: 'Deposit Account', to: 'depositAccountId' },
        { from: 'Receipt Number', to: 'receiptNumber' },
        { from: 'Closed', to: 'closed' },
        { from: 'Item', to: 'itemId', group: 'entries' },
        { from: 'Quantity', to: 'quantity', group: 'entries' },
        { from: 'Rate', to: 'rate', group: 'entries' },
      ]);
      await previewAndImport(importId, 1);

      const list = await http()
        .get('/sale-receipts')
        .query({ searchKeyword: receiptNo })
        .set(authHeaders())
        .expect(200);
      const receipt = rowsOf(list.body).find(
        (row) => (row.receipt_number ?? row.receiptNumber) === receiptNo,
      );
      expect(receipt).toBeDefined();
      expect(Number(receipt.total ?? receipt.amount)).toBe(120);
    });

    it('imports tax rates from the sample sheet layout', async () => {
      const sample = await http()
        .get('/import/sample')
        .query({ resource: 'tax-rate', format: 'csv' })
        .set(authHeaders())
        .expect(200);
      const header = csvLines(sample.text)[0];
      expect(header).toBe(
        'Tax Name,Code,Rate,Description,Is Non Recoverable,Active',
      );
      const codes = [`IMP-T1-${tag}`, `IMP-T2-${tag}`];
      const csv = [
        header,
        `Imported VAT ${tag},${codes[0]},12.5,Standard,F,T`,
        `Imported Luxury ${tag},${codes[1]},25,Luxury,T,T`,
      ].join('\n');
      const importId = await uploadAndMap('tax-rate', csv, [
        { from: 'Tax Name', to: 'name' },
        { from: 'Code', to: 'code' },
        { from: 'Rate', to: 'rate' },
        { from: 'Description', to: 'description' },
        { from: 'Is Non Recoverable', to: 'isNonRecoverable' },
        { from: 'Active', to: 'active' },
      ]);
      await previewAndImport(importId, 2);

      const list = await http()
        .get('/tax-rates')
        .set(authHeaders())
        .expect(200);
      const imported = rowsOf(list.body).filter((row) =>
        codes.includes(row.code),
      );
      expect(imported.map((row) => Number(row.rate)).sort()).toEqual([
        12.5, 25,
      ]);
      const luxury = imported.find((row) => row.code === codes[1]);
      expect(
        Boolean(luxury.is_non_recoverable ?? luxury.isNonRecoverable),
      ).toBe(true);
    });
  });

  describe('F2: every export in the webapp downloads a CSV', () => {
    it.each(WEBAPP_EXPORT_RESOURCES)('%s CSV', async (resource) => {
      const res = await http()
        .get('/export')
        .query({ resource })
        .set(authHeaders())
        .set('Accept', 'application/csv')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      // Header row at least.
      expect(csvLines(res.text).length).toBeGreaterThanOrEqual(1);
    });

    it('payments received and receipts exports contain their rows', async () => {
      const payments = await http()
        .get('/export')
        .query({ resource: 'payment_received' })
        .set(authHeaders())
        .set('Accept', 'application/csv')
        .expect(200);
      expect(payments.text).toContain(`PAY-${tag}`);

      const receipts = await http()
        .get('/export')
        .query({ resource: 'sale_receipt' })
        .set(authHeaders())
        .set('Accept', 'application/csv')
        .expect(200);
      expect(receipts.text).toContain(`IMP-R-${tag}`);

      const taxRates = await http()
        .get('/export')
        .query({ resource: 'tax_rate' })
        .set(authHeaders())
        .set('Accept', 'application/csv')
        .expect(200);
      expect(taxRates.text).toContain(`IMP-T1-${tag}`);
    });

    it('exports XLSX', async () => {
      const res = await http()
        .get('/export')
        .query({ resource: 'payment_received' })
        .set(authHeaders())
        .set('Accept', 'application/xlsx')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      // XLSX files are zip archives ("PK").
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });
  });

  describe('F2: every print in the webapp downloads a PDF', () => {
    it.each(WEBAPP_PRINT_RESOURCES)('%s PDF has a title', async (resource) => {
      const res = await http()
        .get(`/resources/${resource}/meta`)
        .set(authHeaders())
        .expect(200);
      expect(
        res.body.print?.page_title ?? res.body.print?.pageTitle,
      ).toBeTruthy();
    });

    it.each(WEBAPP_PRINT_RESOURCES)('%s PDF', async (resource) => {
      const res = await http()
        .get('/export')
        .query({ resource })
        .set(authHeaders())
        .set('Accept', 'application/pdf')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });
  });
});
