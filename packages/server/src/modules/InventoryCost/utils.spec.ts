import { ItemEntry } from '../TransactionItemEntry/models/ItemEntry';
import { transformItemEntriesToInventory } from './utils';

/**
 * I3: stock coming in from a bill was valued at the raw unit price, with
 * the VAT inside a tax-inclusive price and before the line discount, while
 * the books put the net amount into the inventory account.
 */
describe('transformItemEntriesToInventory', () => {
  const entry = (attrs: Partial<ItemEntry>) =>
    ItemEntry.fromJson({
      id: 1,
      itemId: 9,
      quantity: 10,
      rate: 100,
      discount: 0,
      taxRate: 0,
      isInclusiveTax: 0,
      ...attrs,
    } as any);

  const lotCost = (
    attrs: Partial<ItemEntry>,
    direction: 'IN' | 'OUT' = 'IN',
    exchangeRate = 1,
  ) => {
    const [transaction] = transformItemEntriesToInventory({
      transactionId: 1,
      transactionType: 'Bill',
      exchangeRate,
      date: '2026-01-01',
      direction,
      createdAt: new Date(),
      entries: [entry(attrs)],
    });
    return {
      rate: transaction.rate,
      cost: transaction.rate * transaction.quantity,
    };
  };

  it('excludes the VAT inside a tax-inclusive price (10 x 110 incl. 10% = 1,000)', () => {
    const { cost, rate } = lotCost({
      rate: 110,
      taxRate: 10,
      isInclusiveTax: 1,
    });
    expect(rate).toBeCloseTo(100, 8);
    expect(cost).toBeCloseTo(1000, 8);
  });

  it('excludes tax added on top of the price (10 x 100 + 10% = 1,000)', () => {
    const { cost } = lotCost({ rate: 100, taxRate: 10, isInclusiveTax: 0 });
    expect(cost).toBeCloseTo(1000, 8);
  });

  it('takes off a percentage discount (10 x 100 less 10% = 900)', () => {
    const { cost } = lotCost({
      discount: 10,
      discountType: 'percentage' as any,
    });
    expect(cost).toBeCloseTo(900, 8);
  });

  it('takes off a fixed discount (10 x 100 less 50 = 950)', () => {
    const { cost } = lotCost({ discount: 50, discountType: 'amount' as any });
    expect(cost).toBeCloseTo(950, 8);
  });

  it('applies discount and inclusive tax together', () => {
    // 4 x 115 = 460 incl. 15%, 10% off = 414, tax 54 -> 360 net.
    const { cost } = lotCost({
      quantity: 4,
      rate: 115,
      discount: 10,
      discountType: 'percentage' as any,
      taxRate: 15,
      isInclusiveTax: 1,
    });
    expect(cost).toBeCloseTo(360, 8);
  });

  it('converts a foreign bill line at the exchange rate, rounded like the ledger', () => {
    // EUR 99.99 x 1.2345678 = 123.4444... -> 123.44 in the base currency.
    const { cost } = lotCost({ quantity: 3, rate: 33.33 }, 'IN', 1.2345678);
    expect(cost).toBeCloseTo(123.44, 8);
  });

  it('keeps decimal quantities exact (2.5 x 33.33 = 83.33)', () => {
    const { cost } = lotCost({ quantity: 2.5, rate: 33.33 });
    expect(cost).toBeCloseTo(83.33, 8);
  });

  it('keeps the entry price on stock going out (its cost comes from the lots)', () => {
    const { rate } = lotCost(
      { rate: 110, taxRate: 10, isInclusiveTax: 1 },
      'OUT',
    );
    expect(rate).toBe(110);
  });

  it('falls back to the unit price for entries without line totals', () => {
    const [transaction] = transformItemEntriesToInventory({
      transactionId: 1,
      transactionType: 'Bill',
      exchangeRate: 2,
      date: '2026-01-01',
      direction: 'IN',
      createdAt: new Date(),
      entries: [{ id: 1, itemId: 9, quantity: 2, rate: 7 }],
    });
    expect(transaction.rate).toBe(14);
  });
});
