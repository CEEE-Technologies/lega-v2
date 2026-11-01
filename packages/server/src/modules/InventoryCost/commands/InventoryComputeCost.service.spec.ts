import { InventoryComputeCostService } from './InventoryComputeCost.service';

/**
 * I1: the cost recalculation job is debounced. A later schedule for the same
 * item replaced the waiting one and threw its (earlier) date away, and the
 * waiting-job key had no company in it.
 */
describe('InventoryComputeCostService.scheduleComputeItemCost', () => {
  let redisStore: Record<string, string>;
  let jobs: Record<string, { data: any; state: string; removed: boolean }>;
  let organizationId: string;
  let service: InventoryComputeCostService;
  let queue: { add: jest.Mock; getJob: jest.Mock };

  beforeEach(() => {
    redisStore = {};
    jobs = {};
    organizationId = 'org-a';

    const redisClient = {
      get: jest.fn(async (key: string) => redisStore[key] ?? null),
      set: jest.fn(async (key: string, value: string) => {
        redisStore[key] = value;
        return 'OK';
      }),
    };
    queue = {
      add: jest.fn(async (_name: string, data: any, opts: any) => {
        jobs[opts.jobId] = { data, state: 'delayed', removed: false };
        return { id: opts.jobId };
      }),
      getJob: jest.fn(async (jobId: string) => {
        const job = jobs[jobId];
        if (!job || job.removed) return undefined;
        return {
          id: jobId,
          data: job.data,
          getState: async () => job.state,
          remove: async () => {
            job.removed = true;
          },
        };
      }),
    };
    const cls = {
      get: jest.fn((key: string) =>
        key === 'organizationId' ? organizationId : 1,
      ),
    };
    service = new InventoryComputeCostService(
      {} as any,
      {} as any,
      cls as any,
      { getOrThrow: () => redisClient } as any,
      queue as any,
      (() => ({})) as any,
      (() => ({})) as any,
    );
  });

  const pendingJobs = () =>
    Object.values(jobs).filter((job) => !job.removed && job.state !== 'done');

  it('keeps the earliest date when a later date is scheduled second', async () => {
    await service.scheduleComputeItemCost(5, '2026-01-15');
    await service.scheduleComputeItemCost(5, '2026-06-15');

    const pending = pendingJobs();
    expect(pending).toHaveLength(1);
    expect(new Date(pending[0].data.startingDate)).toEqual(
      new Date('2026-01-15'),
    );
  });

  it('keeps the earliest date when an earlier date is scheduled second', async () => {
    await service.scheduleComputeItemCost(5, '2026-06-15');
    await service.scheduleComputeItemCost(5, '2026-01-15');

    const pending = pendingJobs();
    expect(pending).toHaveLength(1);
    expect(new Date(pending[0].data.startingDate)).toEqual(
      new Date('2026-01-15'),
    );
  });

  it('accepts Date objects as well as strings', async () => {
    await service.scheduleComputeItemCost(5, new Date('2026-03-01'));
    await service.scheduleComputeItemCost(5, '2026-02-01');
    await service.scheduleComputeItemCost(5, new Date('2026-04-01'));

    const pending = pendingJobs();
    expect(pending).toHaveLength(1);
    expect(new Date(pending[0].data.startingDate)).toEqual(
      new Date('2026-02-01'),
    );
  });

  it('does not let two companies with the same item id cancel each other', async () => {
    organizationId = 'org-a';
    await service.scheduleComputeItemCost(5, '2026-01-15');
    organizationId = 'org-b';
    await service.scheduleComputeItemCost(5, '2026-06-15');

    const pending = pendingJobs();
    expect(pending).toHaveLength(2);
    expect(pending.map((job) => job.data.organizationId).sort()).toEqual([
      'org-a',
      'org-b',
    ]);
  });

  it('keeps different items apart', async () => {
    await service.scheduleComputeItemCost(5, '2026-01-15');
    await service.scheduleComputeItemCost(6, '2026-06-15');

    expect(pendingJobs()).toHaveLength(2);
  });

  it('schedules a new job without merging when the previous one already runs', async () => {
    await service.scheduleComputeItemCost(5, '2026-01-15');
    Object.values(jobs)[0].state = 'active';

    await service.scheduleComputeItemCost(5, '2026-06-15');

    const all = Object.values(jobs);
    expect(all).toHaveLength(2);
    expect(all[0].removed).toBe(false);
    // The running job covers January; the new one only needs June.
    expect(new Date(all[1].data.startingDate)).toEqual(new Date('2026-06-15'));
  });
});
