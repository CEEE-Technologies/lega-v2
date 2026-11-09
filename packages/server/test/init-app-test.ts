import request = require('supertest');
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/modules/App/App.module';

let app: INestApplication;

// E2E_EMAIL / E2E_PASSWORD run the suite against another test company.
const email = process.env.E2E_EMAIL || 'kk@kk.com';
const password = process.env.E2E_PASSWORD || '1231231230';

let orgainzationId = '';
let authenticationToken = '';
let AuthorizationHeader = '';
let authenticatedUserId: number | undefined;

beforeAll(async () => {
  // Each test file gets its own queues. With one prefix for the whole run,
  // a queue worker of an earlier file's app, still finishing a job, could
  // take this file's jobs (an organization build) after that app had
  // closed its database pools, and fail them.
  process.env.E2E_QUEUE_PREFIX_BASE ??= process.env.QUEUE_PREFIX || 'e2e';
  process.env.QUEUE_PREFIX = `${process.env.E2E_QUEUE_PREFIX_BASE}-${randomUUID().slice(0, 8)}`;

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  // As in main.ts: webhooks check signatures against the raw body.
  app = moduleFixture.createNestApplication({ rawBody: true });
  await app.init();
  // Listen once, so every request reuses this server. supertest otherwise
  // starts and stops a server for each request, and requests sent in
  // parallel then drop each other's connections (ECONNRESET).
  await app.listen(0, '127.0.0.1');

  const signinResponse = await request(app.getHttpServer())
    .post('/auth/signin')
    .send({ email, password });

  authenticationToken = signinResponse.body.access_token;
  AuthorizationHeader = `Bearer ${authenticationToken}`;
  orgainzationId = signinResponse.body.organization_id;
  authenticatedUserId = signinResponse.body.user_id;
});

afterAll(async () => {
  await app.close();
});
jest.retryTimes(3, { logErrorsBeforeRetry: true });

/**
 * Runs the rest of this test file in another company (for example one made
 * with `createCompany`): the shared helpers read the organization and the
 * token from here, so the file changes nothing in the shared test company.
 * Each test file loads this module afresh, so other files are unaffected.
 */
const useCompany = (organizationId: string, token: string, userId?: number) => {
  orgainzationId = organizationId;
  authenticationToken = token;
  AuthorizationHeader = `Bearer ${token}`;
  authenticatedUserId = userId;
};

export {
  useCompany,
  app,
  orgainzationId,
  authenticationToken,
  AuthorizationHeader,
  authenticatedUserId,
};
