import { Knex } from 'knex';

/**
 * The connection pools of the company databases, one per database, kept
 * for the life of the app and closed when it shuts down
 * (DatabasePoolsShutdown). Closing the app (the e2e tests, the CLI) used to
 * leave every pool open.
 *
 * There is no size limit on purpose: the pools keep no idle connections
 * (min 0), so an unused pool costs no database connection, while closing a
 * pool that a long job still holds (a cash basis rebuild keeps one for its
 * whole run) would fail that job.
 */
export class KnexPoolCache {
  /** Every cache, so shutdown can close them all (see DatabasePoolsShutdown). */
  private static readonly caches = new Set<KnexPoolCache>();

  /** Closes the pools of every cache now. */
  static async closeAllCaches(): Promise<void> {
    await Promise.all([...KnexPoolCache.caches].map((c) => c.closeAll()));
  }

  private readonly pools = new Map<string, Knex>();

  constructor() {
    KnexPoolCache.caches.add(this);
  }

  get(database: string): Knex | undefined {
    return this.pools.get(database);
  }

  set(database: string, instance: Knex): void {
    this.pools.set(database, instance);
  }

  get size(): number {
    return this.pools.size;
  }

  /** Closes every pool now (on shutdown) and empties the cache. */
  async closeAll(): Promise<void> {
    const instances = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(
      instances.map((instance) => instance.destroy().catch(() => undefined)),
    );
  }
}
