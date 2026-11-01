import { InventoryAverageCostMethod } from './InventoryAverageCostMethod';

let nextId = 1;
const tx = (attrs: Record<string, any>): any => ({
  id: nextId++,
  itemId: 1,
  entryId: 1,
  date: '2026-01-01',
  createdAt: new Date(2026, 0, 1, 0, 0, nextId),
  ...attrs,
});

const bill = (quantity: number, rate: number, extra = {}) =>
  tx({ direction: 'IN', transactionType: 'Bill', quantity, rate, ...extra });
const sale = (quantity: number, rate: number, extra = {}) =>
  tx({
    direction: 'OUT',
    transactionType: 'SaleInvoice',
    quantity,
    rate,
    ...extra,
  });
const creditNote = (quantity: number, rate: number, extra = {}) =>
  tx({
    direction: 'IN',
    transactionType: 'CreditNote',
    quantity,
    rate,
    ...extra,
  });
const transfer = (
  direction: 'IN' | 'OUT',
  quantity: number,
  rate: number,
  extra = {},
) =>
  tx({
    direction,
    transactionType: 'WarehouseTransfer',
    transactionId: 50,
    quantity,
    rate,
    ...extra,
  });

/** Stock value left after the lots: IN costs less OUT costs. */
const stockValue = (lots: any[]) =>
  lots.reduce((acc, l) => acc + (l.direction === 'IN' ? l.cost : -l.cost), 0);
const stockQuantity = (lots: any[]) =>
  lots.reduce(
    (acc, l) => acc + (l.direction === 'IN' ? l.quantity : -l.quantity),
    0,
  );
const lotOf = (lots: any[], type: string, direction: string) =>
  lots.filter((l) => l.transactionType === type && l.direction === direction);

describe('InventoryAverageCostMethod', () => {
  const tracker = new InventoryAverageCostMethod();

  it('costs a sale at the average cost (unchanged behaviour)', () => {
    const lots = tracker.trackingCostTransactions([
      bill(10, 50),
      bill(10, 70),
      sale(5, 999),
    ]);
    expect(lotOf(lots, 'SaleInvoice', 'OUT')[0].cost).toBeCloseTo(300, 8);
    expect(stockValue(lots)).toBeCloseTo(900, 8);
  });

  describe('I4: customer returns', () => {
    it('a full return goes back at cost, not at the selling price', () => {
      // Buy 10 at 50 (500), sell 1 for 100, the customer returns it.
      const lots = tracker.trackingCostTransactions([
        bill(10, 50),
        sale(1, 100, { date: '2026-01-02' }),
        creditNote(1, 100, { date: '2026-01-03' }),
      ]);
      const [ret] = lotOf(lots, 'CreditNote', 'IN');
      expect(ret.cost).toBeCloseTo(50, 8);
      expect(ret.rate).toBeCloseTo(50, 8);
      expect(stockValue(lots)).toBeCloseTo(500, 8);
      expect(stockQuantity(lots)).toBe(10);
    });

    it('a partial return of a decimal quantity comes back at the average cost', () => {
      const lots = tracker.trackingCostTransactions([
        bill(4, 33.33),
        sale(3, 80, { date: '2026-01-02' }),
        creditNote(1.5, 80, { date: '2026-01-03' }),
      ]);
      expect(lotOf(lots, 'CreditNote', 'IN')[0].cost).toBeCloseTo(
        1.5 * 33.33,
        8,
      );
      expect(stockValue(lots)).toBeCloseTo(2.5 * 33.33, 8);
    });

    it('a return after everything was sold uses the last average cost', () => {
      const lots = tracker.trackingCostTransactions([
        bill(2, 40),
        sale(2, 100, { date: '2026-01-02' }),
        creditNote(1, 100, { date: '2026-01-03' }),
      ]);
      expect(lotOf(lots, 'CreditNote', 'IN')[0].cost).toBeCloseTo(40, 8);
    });

    it('a return recomputed from its own date uses the given fallback average', () => {
      const lots = tracker.trackingCostTransactions(
        [creditNote(1, 100, { date: '2026-01-03' })],
        0,
        0,
        45,
      );
      expect(lotOf(lots, 'CreditNote', 'IN')[0].cost).toBeCloseTo(45, 8);
    });

    it('a return with opening stock uses the opening average', () => {
      const lots = tracker.trackingCostTransactions(
        [creditNote(2, 100, { date: '2026-01-03' })],
        8,
        400,
      );
      expect(lotOf(lots, 'CreditNote', 'IN')[0].cost).toBeCloseTo(100, 8);
    });
  });

  describe('I7: warehouse transfers', () => {
    it('a transfer with no cost keeps the total value', () => {
      // 10 units worth 1,000 move from Main to Branch; the transfer has no cost.
      const lots = tracker.trackingCostTransactions([
        bill(10, 100),
        transfer('IN', 10, 0, { warehouseId: 2 }),
        transfer('OUT', 10, 0, { warehouseId: 1 }),
      ]);
      expect(lotOf(lots, 'WarehouseTransfer', 'IN')[0].cost).toBeCloseTo(
        1000,
        8,
      );
      expect(stockValue(lots)).toBeCloseTo(1000, 8);
    });

    it('a transfer with a wrong cost keeps the total value', () => {
      const lots = tracker.trackingCostTransactions([
        bill(10, 100),
        transfer('IN', 4, 250, { warehouseId: 2 }),
        transfer('OUT', 4, 250, { warehouseId: 1 }),
        sale(10, 150, { date: '2026-01-05' }),
      ]);
      expect(lotOf(lots, 'WarehouseTransfer', 'IN')[0].cost).toBeCloseTo(
        400,
        8,
      );
      expect(lotOf(lots, 'SaleInvoice', 'OUT')[0].cost).toBeCloseTo(1000, 8);
      expect(stockValue(lots)).toBeCloseTo(0, 8);
    });

    it('a bill on the same date booked after the transfer still leaves the value unchanged', () => {
      const lots = tracker.trackingCostTransactions([
        bill(10, 100),
        transfer('IN', 5, 0, { warehouseId: 2 }),
        bill(10, 200),
        transfer('OUT', 5, 0, { warehouseId: 1 }),
      ]);
      const outCost = lotOf(lots, 'WarehouseTransfer', 'OUT')[0].cost;
      const inCost = lotOf(lots, 'WarehouseTransfer', 'IN')[0].cost;
      expect(inCost).toBeCloseTo(outCost, 8);
      expect(stockValue(lots)).toBeCloseTo(3000, 8);
    });

    it('a back-dated bill re-works both sides of the transfer together', () => {
      const lots = tracker.trackingCostTransactions([
        bill(10, 100, { date: '2026-01-01' }),
        bill(10, 300, { date: '2026-01-02' }), // back-dated purchase
        transfer('IN', 10, 100, { date: '2026-01-03', warehouseId: 2 }),
        transfer('OUT', 10, 100, { date: '2026-01-03', warehouseId: 1 }),
      ]);
      expect(lotOf(lots, 'WarehouseTransfer', 'IN')[0].cost).toBeCloseTo(
        2000,
        8,
      );
      expect(stockValue(lots)).toBeCloseTo(4000, 8);
    });

    it('two lines of the same item in one transfer each keep their own cost', () => {
      const lots = tracker.trackingCostTransactions([
        bill(10, 100),
        transfer('IN', 2, 0, { entryId: 1 }),
        transfer('IN', 3.5, 0, { entryId: 2 }),
        transfer('OUT', 2, 0, { entryId: 1 }),
        transfer('OUT', 3.5, 0, { entryId: 2 }),
      ]);
      const ins = lotOf(lots, 'WarehouseTransfer', 'IN');
      expect(ins.map((l) => l.cost)).toEqual([
        expect.closeTo(200, 8),
        expect.closeTo(350, 8),
      ]);
      expect(stockValue(lots)).toBeCloseTo(1000, 8);
    });

    it('a transfer of more than the stock carries only the cost that left', () => {
      const lots = tracker.trackingCostTransactions([
        bill(2, 100),
        transfer('IN', 5, 0),
        transfer('OUT', 5, 0),
      ]);
      expect(stockValue(lots)).toBeCloseTo(200, 8);
    });
  });
});
