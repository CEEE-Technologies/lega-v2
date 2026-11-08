import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Knex } from 'knex';
import { SystemKnexConnection } from '@/modules/System/SystemDB/SystemDB.constants';
import { KnexPoolCache } from './KnexPoolCache';

/**
 * Closes the database pools when the app shuts down: the system database
 * and every company database pool (the app's own and the analytics ones).
 * They used to stay open, so every app closed in one process (the e2e test
 * files, the CLI) left its connections behind.
 *
 * Registered in the root AppModule on purpose: Nest runs shutdown hooks
 * module by module, the root last, so the queue workers have finished
 * their running jobs (which still need the database) before this runs.
 */
@Injectable()
export class DatabasePoolsShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(SystemKnexConnection)
    private readonly systemKnex: Knex,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await KnexPoolCache.closeAllCaches();
    await this.systemKnex.destroy().catch(() => undefined);
  }
}
