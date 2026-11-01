import request = require('supertest');
import * as fs from 'fs';
import * as path from 'path';
import { faker } from '@faker-js/faker';
import { Knex } from 'knex';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemKnexConnection } from '../../src/modules/System/SystemDB/SystemDB.constants';

export const PASSWORD = 'Secur1ty-Test-Pass';

export interface Session {
  email: string;
  password: string;
  token: string;
  systemUserId: number;
}

export interface Company {
  owner: Session;
  organizationId: string;
  tenantId: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const uniqueEmail = (label: string) =>
  `sec-${label}-${faker.string.alphanumeric(8).toLowerCase()}@example.com`;

export const systemKnex = (app: INestApplication): Knex =>
  app.get<Knex>(SystemKnexConnection);

/** Signs in and returns the token and the organization that opens. */
export const signin = async (
  app: INestApplication,
  email: string,
  password: string = PASSWORD,
) => {
  const res = await request(app.getHttpServer())
    .post('/auth/signin')
    .send({ email, password });
  return res;
};

/** Sends an authenticated request for the given organization. */
export const as = (
  app: INestApplication,
  session: Pick<Session, 'token'>,
  organizationId: string,
) => {
  const server = request(app.getHttpServer());
  const withHeaders = (req: request.Test) =>
    req
      .set('Authorization', `Bearer ${session.token}`)
      .set('organization-id', organizationId);
  return {
    get: (url: string) => withHeaders(server.get(url)),
    post: (url: string) => withHeaders(server.post(url)),
    put: (url: string) => withHeaders(server.put(url)),
    patch: (url: string) => withHeaders(server.patch(url)),
    delete: (url: string) => withHeaders(server.delete(url)),
  };
};

/**
 * Points the test app at the compiled tenant migrations. The migrations in
 * `src` are TypeScript and knex only loads `.js` files, so without this the
 * test app can't build a new organization itself. Needs `pnpm build` first.
 */
const useCompiledTenantMigrations = (app: INestApplication) => {
  const dir = path.join(__dirname, '../../dist/database/tenant/migrations');
  if (!fs.existsSync(dir)) {
    throw new Error(
      'Run `pnpm build` in packages/server first: building a test organization needs the compiled tenant migrations.',
    );
  }
  app.get(ConfigService).set('tenantDatabase.migrationsDir', dir);
};

/**
 * Signs up a new owner and builds their organization, waiting for the build
 * job to finish. Everything is new, so nothing shared is touched.
 */
export const createCompany = async (
  app: INestApplication,
  label: string,
): Promise<Company> => {
  useCompiledTenantMigrations(app);
  const email = uniqueEmail(`${label}-owner`);
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      firstName: `${label}Owner`,
      lastName: 'Test',
      email,
      password: PASSWORD,
    });
  if (signup.status >= 300) {
    throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  }
  const organizationId = signup.body.organization_id;
  const signinRes = await signin(app, email);
  const owner: Session = {
    email,
    password: PASSWORD,
    token: signinRes.body.access_token,
    systemUserId: signinRes.body.user_id,
  };
  const build = await as(app, owner, organizationId)
    .post('/organization/build')
    .send({
      name: `Security ${label} Ltd`,
      baseCurrency: 'USD',
      location: 'US',
      language: 'en',
      fiscalYear: 'january',
      timezone: 'US/Central',
    });
  if (build.status !== 200) {
    throw new Error(
      `Build failed: ${build.status} ${JSON.stringify(build.body)}`,
    );
  }
  const jobId = build.body.data.job_id;

  for (let i = 0; i < 240; i++) {
    const job = await as(app, owner, organizationId).get(
      `/organization/build/${jobId}`,
    );
    if (job.body.is_failed) {
      throw new Error(`Build job failed: ${JSON.stringify(job.body)}`);
    }
    const tenant = await systemKnex(app)('tenants')
      .where({ organizationId })
      .first();
    if (job.body.is_completed && tenant?.initializedAt && tenant?.seededAt) {
      return { owner, organizationId, tenantId: tenant.id };
    }
    await sleep(500);
  }
  throw new Error('The organization build did not finish in time.');
};

/** Reads the newest invite token sent to the email for the organization. */
export const getInviteToken = async (
  app: INestApplication,
  email: string,
  tenantId: number,
) => {
  const invite = await systemKnex(app)('user_invites')
    .where({ email, tenantId })
    .orderBy('id', 'desc')
    .first();
  return invite?.token as string | undefined;
};

/**
 * Invites the email to the company with the role and accepts the invite.
 * A new email gets a new login with the test password; an existing login
 * accepts with its current password.
 */
export const inviteAndAccept = async (
  app: INestApplication,
  company: Company,
  inviter: Session,
  email: string,
  roleId: number,
): Promise<Session> => {
  const invite = await as(app, inviter, company.organizationId)
    .patch('/invite')
    .send({ email, roleId });
  if (invite.status !== 200) {
    throw new Error(
      `Invite failed: ${invite.status} ${JSON.stringify(invite.body)}`,
    );
  }
  const token = await getInviteToken(app, email, company.tenantId);
  const accept = await request(app.getHttpServer())
    .post(`/invite/accept/${token}`)
    .send({ firstName: 'Invited', lastName: 'User', password: PASSWORD });
  if (accept.status >= 300) {
    throw new Error(
      `Accept failed: ${accept.status} ${JSON.stringify(accept.body)}`,
    );
  }
  const res = await signin(app, email);
  return {
    email,
    password: PASSWORD,
    token: res.body.access_token,
    systemUserId: res.body.user_id,
  };
};

/** The tenant user id of the login in the company. */
export const getTenantUserId = async (
  app: INestApplication,
  company: Company,
  systemUserId: number,
): Promise<number> => {
  const users = await as(app, company.owner, company.organizationId).get(
    '/users',
  );
  const user = users.body.find((u: any) => u.system_user_id === systemUserId);
  return user?.id;
};

/** Creates a role with only the given permissions and returns its id. */
export const createRole = async (
  app: INestApplication,
  company: Company,
  name: string,
  permissions: Array<{ subject: string; ability: string }>,
): Promise<number> => {
  const res = await as(app, company.owner, company.organizationId)
    .post('/roles')
    .send({
      roleName: `${name} ${faker.string.alphanumeric(5)}`,
      roleDescription: name,
      permissions: permissions.map((p) => ({ ...p, value: true })),
    });
  if (res.status !== 201) {
    throw new Error(`Role failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id;
};

export const ADMIN_ROLE_ID = 1;

/** The error type of a ServiceError response. */
export const errorType = (res: request.Response) => res.body?.errors?.[0]?.type;
