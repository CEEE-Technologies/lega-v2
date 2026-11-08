import request = require('supertest');
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import {
  app as sharedApp,
  AuthorizationHeader,
  orgainzationId,
} from './init-app-test';
import { AppModule } from '../src/modules/App/App.module';

/**
 * F15: closing the app closes its database pools (the system database, the
 * company databases and the analytics ones). They used to stay open, so a
 * run of many test files in one process used up MariaDB's connections.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('F15: database pools close with the app (e2e)', () => {
  let monitor: Knex;

  /** The connections the test's database user holds right now. */
  const connections = async () => {
    const [rows] = await monitor.raw(
      'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ?',
      [sharedApp.get(ConfigService).get('tenantDatabase.user')],
    );
    return Number(rows[0].n);
  };

  /** Starts the app, uses the system and a company database, closes it. */
  const openUseAndClose = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    try {
      // Several requests at once, so each pool opens more than one connection.
      const responses = await Promise.all(
        ['/accounts', '/items', '/customers', '/vendors'].map((url) =>
          request(app.getHttpServer())
            .get(url)
            .set('organization-id', orgainzationId)
            .set('Authorization', AuthorizationHeader),
        ),
      );
      responses.forEach((res) => expect(res.status).toBe(200));
    } finally {
      await app.close();
    }
  };

  beforeAll(() => {
    const config = sharedApp.get(ConfigService).get('tenantDatabase');
    monitor = knexFactory({
      client: config.client,
      connection: {
        host: config.host,
        port: Number(config.port),
        user: config.user,
        password: config.password,
      },
      pool: { min: 1, max: 1 },
    });
  });

  afterAll(async () => {
    await monitor?.destroy();
  });

  it('opening and closing the app twice leaves no connections behind', async () => {
    await connections();
    const before = await connections();

    await openUseAndClose();
    await openUseAndClose();
    await sleep(500);

    // Other clients (a dev server, the shared test app) may open or close a
    // connection meanwhile; two apps' leaked pools were far more than this.
    expect(await connections()).toBeLessThanOrEqual(before + 2);
  });
});
