import request = require('supertest');
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';

describe('Banking Recognized Transactions (e2e)', () => {
  const get = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);

  it('/banking/recognized (GET)', () => {
    return get('/banking/recognized').expect(200);
  });

  // A recognized line is covered end to end in
  // round-4-recognized-bank-line.e2e-spec.ts.
  it('/banking/recognized/:recognizedTransactionId (GET) unknown is not found', async () => {
    expect((await get('/banking/recognized/999999999')).status).toBe(404);
  });
});
