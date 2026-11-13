import request = require('supertest');
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';
import {
  accountIdOfType,
  createTestBankAccount,
  insertBankLine,
} from './_utils/banking';
import { getTenantKnex } from './_utils/money-matrix';

describe('Banking Categorize (e2e)', () => {
  let bankId: number;
  let equityId: number;

  const categorize = (lineIds: number[]) =>
    request(app.getHttpServer())
      .post('/banking/categorize')
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader)
      .send({
        uncategorizedTransactionIds: lineIds,
        date: '2026-04-10',
        transactionType: 'owner_contribution',
        creditAccountId: equityId,
      });

  const isCategorized = async (lineId: number) =>
    Boolean(
      Number(
        (
          await getTenantKnex()('uncategorized_cashflow_transactions')
            .where({ id: lineId })
            .first()
        ).categorized,
      ),
    );

  beforeAll(async () => {
    bankId = await createTestBankAccount();
    equityId = await accountIdOfType('equity');
  });

  it('/banking/categorize (POST)', async () => {
    const lineId = await insertBankLine(bankId, 120);
    const res = await categorize([lineId]);
    expect(res.status).toBe(201);
    expect(await isCategorized(lineId)).toBe(true);
  });

  it('/banking/categorize/:id (DELETE)', async () => {
    const lineId = await insertBankLine(bankId, 80);
    expect((await categorize([lineId])).status).toBe(201);

    const res = await request(app.getHttpServer())
      .delete(`/banking/categorize/${lineId}`)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);
    expect(res.status).toBe(200);
    expect(await isCategorized(lineId)).toBe(false);
  });

  it('/banking/categorize/bulk (DELETE)', async () => {
    const a = await insertBankLine(bankId, 10);
    const b = await insertBankLine(bankId, 20);
    expect((await categorize([a])).status).toBe(201);
    expect((await categorize([b])).status).toBe(201);

    const res = await request(app.getHttpServer())
      .delete('/banking/categorize/bulk')
      .query({ uncategorizedTransactionIds: [a, b] })
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);
    expect(res.status).toBe(200);
    expect(await isCategorized(a)).toBe(false);
    expect(await isCategorized(b)).toBe(false);
  });
});
