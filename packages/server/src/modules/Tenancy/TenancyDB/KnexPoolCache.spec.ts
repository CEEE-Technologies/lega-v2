import { KnexPoolCache } from './KnexPoolCache';

describe('KnexPoolCache', () => {
  const pool = () => ({ destroy: jest.fn(() => Promise.resolve()) }) as any;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('closes a pool pushed out by the size limit, after the delay', () => {
    const cache = new KnexPoolCache(2, 1000);
    const a = pool();
    cache.set('db_a', a);
    cache.set('db_b', pool());
    cache.set('db_c', pool());

    expect(cache.get('db_a')).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(a.destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(a.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the recently used pools', () => {
    const cache = new KnexPoolCache(2, 1000);
    const a = pool();
    const b = pool();
    cache.set('db_a', a);
    cache.set('db_b', b);
    cache.get('db_a');
    cache.set('db_c', pool());

    expect(cache.get('db_a')).toBe(a);
    expect(cache.get('db_b')).toBeUndefined();
  });

  it('closeAll closes every pool at once and empties the cache', async () => {
    const cache = new KnexPoolCache(10, 1000);
    const pools = [pool(), pool(), pool()];
    pools.forEach((p, i) => cache.set(`db_${i}`, p));

    await cache.closeAll();
    pools.forEach((p) => expect(p.destroy).toHaveBeenCalledTimes(1));
    expect(cache.size).toBe(0);
    jest.advanceTimersByTime(10_000);
    pools.forEach((p) => expect(p.destroy).toHaveBeenCalledTimes(1));
  });
});
