import { Knex } from 'knex';
import * as LRUCache from 'lru-cache';

/** How many company databases keep an open pool (TENANT_DB_POOLS_MAX). */
export const DEFAULT_MAX_POOLS = 100;

/**
 * A pool pushed out of the cache is closed this long after, not at once: a
 * request that already holds it (an open transaction) can still finish.
 */
export const CLOSE_EVICTED_POOL_AFTER_MS = 5 * 60 * 1000;

/**
 * The connection pools of the company databases, one per database. The
 * cache has a size limit, so pools of companies not used for a while are
 * closed instead of piling up, and every pool is closed when the app shuts
 * down (DatabasePoolsShutdown). Without it, every company used since the
 * start kept its pool, and closing the app (the e2e tests, the CLI) left
 * them all open.
 */
export class KnexPoolCache {
  /** Every cache, so shutdown can close them all (see DatabasePoolsShutdown). */
  private static readonly caches = new Set<KnexPoolCache>();

  /** Closes the pools of every cache now. */
  static async closeAllCaches(): Promise<void> {
    await Promise.all([...KnexPoolCache.caches].map((c) => c.closeAll()));
  }

  private readonly cache: LRUCache<string, Knex>;
  private closing = false;

  constructor(
    max: number = Number(process.env.TENANT_DB_POOLS_MAX) || DEFAULT_MAX_POOLS,
    private readonly closeEvictedAfterMs: number = CLOSE_EVICTED_POOL_AFTER_MS,
  ) {
    this.cache = new LRUCache<string, Knex>({
      max,
      dispose: (_database, instance) => {
        if (this.closing) return;
        const timer = setTimeout(() => {
          instance.destroy().catch(() => undefined);
        }, this.closeEvictedAfterMs);
        // A pending close doesn't keep the process alive.
        timer.unref?.();
      },
    });
    KnexPoolCache.caches.add(this);
  }

  get(database: string): Knex | undefined {
    return this.cache.get(database);
  }

  set(database: string, instance: Knex): void {
    this.cache.set(database, instance);
  }

  get size(): number {
    return this.cache.length;
  }

  /** Closes every pool now (on shutdown). */
  async closeAll(): Promise<void> {
    const instances = this.cache.values();
    this.closing = true;
    try {
      this.cache.reset();
    } finally {
      this.closing = false;
    }
    await Promise.all(
      instances.map((instance) => instance.destroy().catch(() => undefined)),
    );
  }
}
