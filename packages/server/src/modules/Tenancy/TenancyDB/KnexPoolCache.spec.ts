import { KnexPoolCache } from './KnexPoolCache';

describe('KnexPoolCache', () => {
  const pool = () => ({ destroy: jest.fn(() => Promise.resolve()) }) as any;

  it('keeps every pool until closed (no limit: a long job may hold one)', () => {
    const cache = new KnexPoolCache();
    const pools = Array.from({ length: 150 }, () => pool());
    pools.forEach((p, i) => cache.set(`db_${i}`, p));

    expect(cache.size).toBe(150);
    expect(cache.get('db_0')).toBe(pools[0]);
    pools.forEach((p) => expect(p.destroy).not.toHaveBeenCalled());
  });

  it('closeAll closes every pool and empties the cache', async () => {
    const cache = new KnexPoolCache();
    const pools = [pool(), pool(), pool()];
    pools.forEach((p, i) => cache.set(`db_${i}`, p));

    await cache.closeAll();
    pools.forEach((p) => expect(p.destroy).toHaveBeenCalledTimes(1));
    expect(cache.size).toBe(0);
  });

  it('closeAllCaches closes the pools of every cache', async () => {
    const a = new KnexPoolCache();
    const b = new KnexPoolCache();
    const pa = pool();
    const pb = pool();
    a.set('db_a', pa);
    b.set('db_b', pb);

    await KnexPoolCache.closeAllCaches();
    expect(pa.destroy).toHaveBeenCalledTimes(1);
    expect(pb.destroy).toHaveBeenCalledTimes(1);
  });
});
