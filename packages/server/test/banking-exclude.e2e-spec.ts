import request = require('supertest');
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';
import { createTestBankAccount, insertBankLine } from './_utils/banking';
import { getTenantKnex } from './_utils/money-matrix';

describe('Banking Exclude (e2e)', () => {
  let bankId: number;

  const call = (method: 'get' | 'put' | 'delete', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);

  const isExcluded = async (lineId: number) =>
    Boolean(
      (
        await getTenantKnex()('uncategorized_cashflow_transactions')
          .where({ id: lineId })
          .first()
      ).excludedAt,
    );

  beforeAll(async () => {
    bankId = await createTestBankAccount();
  });

  it('/banking/exclude (GET)', () => {
    return call('get', '/banking/exclude').expect(200);
  });

  it('/banking/exclude/:id (PUT) and (DELETE)', async () => {
    const lineId = await insertBankLine(bankId, 33);
    expect((await call('put', `/banking/exclude/${lineId}`)).status).toBe(200);
    expect(await isExcluded(lineId)).toBe(true);

    expect((await call('delete', `/banking/exclude/${lineId}`)).status).toBe(
      200,
    );
    expect(await isExcluded(lineId)).toBe(false);
  });

  it('/banking/exclude/bulk (PUT) and (DELETE)', async () => {
    const a = await insertBankLine(bankId, 11);
    const b = await insertBankLine(bankId, 22);
    expect(
      (await call('put', '/banking/exclude/bulk').send({ ids: [a, b] })).status,
    ).toBe(200);
    expect(await isExcluded(a)).toBe(true);
    expect(await isExcluded(b)).toBe(true);

    expect(
      (await call('delete', '/banking/exclude/bulk').send({ ids: [a, b] }))
        .status,
    ).toBe(200);
    expect(await isExcluded(a)).toBe(false);
    expect(await isExcluded(b)).toBe(false);
  });

  it('an unknown line is not found', async () => {
    expect((await call('put', '/banking/exclude/999999999')).status).toBe(404);
  });
});
