import request = require('supertest');
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
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();

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

export {
  app,
  orgainzationId,
  authenticationToken,
  AuthorizationHeader,
  authenticatedUserId,
};
