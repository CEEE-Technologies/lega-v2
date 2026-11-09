import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Knex } from 'knex';
import { SystemKnexConnection } from '@/modules/System/SystemDB/SystemDB.constants';
import { KnexPoolCache } from './KnexPoolCache';
import { settleAfterCommitWork } from './TransactionsHooks';

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
export class DatabasePoolsShutdown
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(
    @Inject(SystemKnexConnection)
    private readonly systemKnex: Knex,
  ) {}

  /**
   * Lets the after-commit work of the last saves finish while the queues
   * and the database are still open (they close in the next phase).
   */
  async beforeApplicationShutdown(): Promise<void> {
    await settleAfterCommitWork();
  }

  async onApplicationShutdown(): Promise<void> {
    // The queue workers closed just before (their modules' hooks run before
    // the root's) and waited for their running jobs: let the after-commit
    // work of those jobs' last saves finish too.
    await settleAfterCommitWork();
    await KnexPoolCache.closeAllCaches();
    await this.systemKnex.destroy().catch(() => undefined);
    new Logger(DatabasePoolsShutdown.name).log('Database pools closed.');
  }
}
