import * as http from 'http';
import { AddressInfo } from 'net';
import { faker } from '@faker-js/faker';
import { Knex } from 'knex';
import { app } from './init-app-test';
import { as, Company, createCompany, tenantKnex } from './_utils/security';

/**
 * F9: when the PDF service (Gotenberg) is down or answers with an error,
 * the invoice PDF endpoint answers 502 PDF_RENDER_FAILED. It used to be a
 * 500 (down), or the error page sent as the PDF with status 200.
 */
jest.retryTimes(0);

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F9: PDF errors (e2e)', () => {
  let company: Company;
  let db: Knex;
  let invoiceId: number;
  const api = () => as(app, company.owner, company.organizationId);
  const realUrl = process.env.GOTENBERG_URL;
  let errorServer: http.Server;
  let errorUrl: string;

  const getPdf = () =>
    api()
      .get(`/sale-invoices/${invoiceId}`)
      .set('Accept', 'application/pdf')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  const expect502 = (res: any) => {
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.errors[0]).toMatchObject({
      type: 'PDF_RENDER_FAILED',
      message: 'The PDF service is unavailable, try again.',
    });
  };

  beforeAll(async () => {
    company = await createCompany(app, 'r4pdf');
    db = tenantKnex(app, company);
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    const itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `F9 service ${faker.string.alphanumeric(6)}`,
          type: 'service',
          sellable: true,
          sellAccountId: await byType('income'),
          sellPrice: 100,
        }),
    ).body.id;
    const customerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `F9 customer ${faker.string.alphanumeric(6)}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id;
    invoiceId = ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: '2026-05-01',
          dueDate: '2026-05-31',
          invoiceNo: `F9-${faker.string.alphanumeric(8)}`,
          delivered: true,
          entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
        }),
    ).body.id;

    // A "PDF service" that only ever answers with an error page.
    errorServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(503, { 'content-type': 'text/html' });
        res.end('<h1>503 Service Unavailable</h1>');
      });
    });
    await new Promise<void>((resolve) => errorServer.listen(0, resolve));
    errorUrl = `http://127.0.0.1:${(errorServer.address() as AddressInfo).port}`;
  }, 300000);

  afterEach(() => {
    process.env.GOTENBERG_URL = realUrl;
  });

  afterAll(async () => {
    process.env.GOTENBERG_URL = realUrl;
    await new Promise((resolve) => errorServer?.close(resolve));
    await db?.destroy();
  });

  it('the PDF service down: 502 PDF_RENDER_FAILED', async () => {
    process.env.GOTENBERG_URL = 'http://127.0.0.1:1';
    expect502(await getPdf());
  });

  it('the PDF service answering with an error page: 502, not the page as the PDF', async () => {
    process.env.GOTENBERG_URL = errorUrl;
    expect502(await getPdf());
  });

  it('the PDF service up: the PDF', async () => {
    const res = await getPdf();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
