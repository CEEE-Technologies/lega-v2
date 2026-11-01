import { AutoIncrementOrdersService } from './AutoIncrementOrders.service';

const makeSettingsStore = (values: Record<string, any>) => ({
  get: ({ group, key }, defaultValue?: any) =>
    values[`${group}.${key}`] ?? defaultValue,
  set: jest.fn(),
  save: jest.fn(),
});

/**
 * A fake knex transaction over an in-memory `settings` table that records
 * whether the next-number row was read with a lock.
 */
const makeTrx = (
  rows: Array<{ id: number; group: string; key: string; value: string }>,
) => {
  const calls = { forUpdate: 0, updates: [] as any[], inserts: [] as any[] };

  const trx: any = (table: string) => {
    expect(table).toBe('settings');
    let where: Record<string, any> = {};
    const builder: any = {
      where: (w: Record<string, any>) => {
        where = { ...where, ...w };
        return builder;
      },
      orderBy: () => builder,
      forUpdate: () => {
        calls.forUpdate += 1;
        return builder;
      },
      first: async () =>
        rows.find((row) =>
          Object.entries(where).every(([k, v]) => row[k] === v),
        ),
      update: async (patch: Record<string, any>) => {
        calls.updates.push({ where, patch });
        rows
          .filter((row) =>
            Object.entries(where).every(([k, v]) => row[k] === v),
          )
          .forEach((row) => Object.assign(row, patch));
      },
      insert: async (row: any) => {
        calls.inserts.push(row);
        rows.push({ id: rows.length + 1, ...row });
      },
    };
    return builder;
  };
  return { trx, calls, rows };
};

describe('AutoIncrementOrdersService.reserveNextNumber', () => {
  const autoOn = {
    'sales_invoices.auto_increment': true,
    'sales_invoices.number_prefix': 'INV-',
    // A stale request cache must not be used: the row below is the truth.
    'sales_invoices.next_number': '00001',
  };

  it('reads the counter under a row lock, bumps it in the same save and returns it', async () => {
    const service = new AutoIncrementOrdersService(
      () => makeSettingsStore(autoOn) as any,
    );
    const { trx, calls, rows } = makeTrx([
      { id: 1, group: 'sales_invoices', key: 'next_number', value: '00041' },
    ]);

    const number = await service.reserveNextNumber('sales_invoices', '', trx);

    expect(number).toBe('INV-00041');
    expect(calls.forUpdate).toBe(1);
    expect(rows[0].value).toBe('00042');
  });

  it('gives two saves in a row different numbers', async () => {
    const service = new AutoIncrementOrdersService(
      () => makeSettingsStore(autoOn) as any,
    );
    const { trx } = makeTrx([
      { id: 1, group: 'sales_invoices', key: 'next_number', value: '00041' },
    ]);

    const first = await service.reserveNextNumber(
      'sales_invoices',
      undefined,
      trx,
    );
    const second = await service.reserveNextNumber(
      'sales_invoices',
      undefined,
      trx,
    );

    expect([first, second]).toEqual(['INV-00041', 'INV-00042']);
  });

  it('keeps a typed number but still bumps the counter, as before', async () => {
    const service = new AutoIncrementOrdersService(
      () => makeSettingsStore(autoOn) as any,
    );
    const { trx, rows } = makeTrx([
      { id: 1, group: 'sales_invoices', key: 'next_number', value: '00041' },
    ]);

    const number = await service.reserveNextNumber(
      'sales_invoices',
      'MY-7',
      trx,
    );

    expect(number).toBe('MY-7');
    expect(rows[0].value).toBe('00042');
  });

  it('rolls over 9s (00099 -> 00100)', async () => {
    const service = new AutoIncrementOrdersService(
      () => makeSettingsStore(autoOn) as any,
    );
    const { trx, rows } = makeTrx([
      { id: 1, group: 'sales_invoices', key: 'next_number', value: '00099' },
    ]);

    expect(await service.reserveNextNumber('sales_invoices', '', trx)).toBe(
      'INV-00099',
    );
    expect(rows[0].value).toBe('00100');
  });

  it('still takes the lock but leaves the counter alone when auto-increment is off', async () => {
    const service = new AutoIncrementOrdersService(
      () =>
        makeSettingsStore({ 'sales_invoices.auto_increment': false }) as any,
    );
    const { trx, calls, rows } = makeTrx([
      { id: 1, group: 'sales_invoices', key: 'next_number', value: '00041' },
    ]);

    expect(await service.reserveNextNumber('sales_invoices', 'A-1', trx)).toBe(
      'A-1',
    );
    expect(await service.reserveNextNumber('sales_invoices', '', trx)).toBe('');
    expect(calls.forUpdate).toBe(2);
    expect(calls.updates).toHaveLength(0);
    expect(rows[0].value).toBe('00041');
  });

  it('creates the counter row from the default when it is missing', async () => {
    const service = new AutoIncrementOrdersService(
      () =>
        makeSettingsStore({
          'credit_note.auto_increment': true,
          'credit_note.next_number': '00001',
        }) as any,
    );
    const { trx, calls } = makeTrx([]);

    expect(await service.reserveNextNumber('credit_note', '', trx)).toBe(
      '00001',
    );
    expect(calls.inserts).toEqual([
      { group: 'credit_note', key: 'next_number', value: '00002' },
    ]);
  });
});
