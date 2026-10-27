import {
  allocateCumulative,
  allocateMoney,
  balanceEntries,
  calcDiscountMoney,
  calcLineMoney,
  compareMoney,
  fromCents,
  hasAtMostDecimals,
  moneyEq,
  moneyGt,
  moneyGte,
  moneyIsZero,
  moneyLt,
  moneyLte,
  multiplyMoney,
  roundHalfAwayFromZero,
  roundMoney,
  subtractMoney,
  sumMoney,
  sumMoneyBy,
  toCents,
  toMoneyNumber,
} from './money';

const sum = (values: number[]) => sumMoney(values);

describe('toMoneyNumber', () => {
  it.each([
    [null, 0],
    [undefined, 0],
    ['', 0],
    ['abc', 0],
    [NaN, 0],
    [Infinity, 0],
    [-0, 0],
    ['12.5', 12.5],
    ['1,234.50', 1234.5],
    [7, 7],
  ])('%p -> %p', (input, expected) => {
    const result = toMoneyNumber(input as any);
    expect(result).toBe(expected);
    expect(Object.is(result, -0)).toBe(false);
  });
});

describe('roundMoney', () => {
  it.each([
    [1.005, 1.01],
    [-1.005, -1.01],
    [0.125, 0.13],
    [-0.125, -0.13],
    [0.124, 0.12],
    [2.675, 2.68],
    [1.1 + 2.2, 3.3],
    [0.1 + 0.2, 0.3],
    [33.333, 33.33],
    [99.995, 100],
    [-0.004, 0],
    [1234567890.125, 1234567890.13],
    [909.0909, 909.09],
    [49.995, 50],
    ['abc', 0],
    [null, 0],
  ])('%p -> %p', (input, expected) => {
    const result = roundMoney(input as any);
    expect(result).toBe(expected);
    expect(Object.is(result, -0)).toBe(false);
  });

  it('rounds to other precisions too', () => {
    expect(roundHalfAwayFromZero(1.0005, 3)).toBe(1.001);
    expect(roundHalfAwayFromZero(-2.5, 0)).toBe(-3);
    expect(roundHalfAwayFromZero(2.5, 0)).toBe(3);
  });
});

describe('cents', () => {
  it('converts to and from whole cents', () => {
    expect(toCents(3.3)).toBe(330);
    expect(toCents(1.1 + 2.2)).toBe(330);
    expect(toCents(-0.125)).toBe(-13);
    expect(toCents('')).toBe(0);
    expect(fromCents(330)).toBe(3.3);
    expect(Object.is(fromCents(-0), -0)).toBe(false);
  });
});

describe('comparisons in cents', () => {
  it('compares float sums as cents', () => {
    expect(moneyEq(1.1 + 2.2, 3.3)).toBe(true);
    expect(moneyLte(1.1 + 2.2, 3.3)).toBe(true);
    expect(moneyGt(1.1 + 2.2, 3.3)).toBe(false);
    expect(moneyLt(3.29, 3.3)).toBe(true);
    expect(moneyGte(3.3, 3.3)).toBe(true);
    expect(compareMoney(3.31, 3.3)).toBe(1);
    expect(compareMoney(3.3, 3.3)).toBe(0);
    expect(compareMoney(3.29, 3.3)).toBe(-1);
  });

  it('treats half cents by the rounding rule', () => {
    // 100.005 rounds to 100.01, so it is more than 100.00.
    expect(moneyGt(100.005, 100)).toBe(true);
    expect(moneyEq(100.004, 100)).toBe(true);
  });

  it('treats a sub-cent amount as zero', () => {
    expect(moneyIsZero(0.004)).toBe(true);
    expect(moneyIsZero(-0.004)).toBe(true);
    expect(moneyIsZero(0.005)).toBe(false);
    expect(moneyIsZero(null)).toBe(true);
  });
});

describe('sumMoney / subtractMoney', () => {
  it('adds in cents', () => {
    expect(sumMoney(1.1, 2.2)).toBe(3.3);
    expect(sumMoney([1.1, 2.2])).toBe(3.3);
    expect(sumMoney([0.1, 0.2], 0.3)).toBe(0.6);
    expect(sumMoney()).toBe(0);
    expect(sumMoney(['10', '', null, 'abc', 5])).toBe(15);
  });

  it('adds large sums without float drift', () => {
    const values = Array.from({ length: 10000 }, () => 0.1);
    expect(sumMoney(values)).toBe(1000);
    expect(values.reduce((a, b) => a + b, 0)).not.toBe(1000);
    expect(sumMoney(9999999999.99, 0.01)).toBe(10000000000);
  });

  it('sums a property of the items', () => {
    const items = [{ amount: 1.1 }, { amount: 2.2 }, { amount: null }];
    expect(sumMoneyBy(items, 'amount')).toBe(3.3);
    expect(sumMoneyBy(items, (item) => item.amount)).toBe(3.3);
    expect(sumMoneyBy(null, 'amount' as never)).toBe(0);
  });

  it('subtracts in cents', () => {
    expect(subtractMoney(3.3, 1.1)).toBe(2.2);
    expect(subtractMoney(3.3, 1.1 + 2.2)).toBe(0);
    expect(subtractMoney(0, 0.01)).toBe(-0.01);
  });

  it('multiplies and rounds', () => {
    expect(multiplyMoney(100, 312.456789)).toBe(31245.68);
    expect(multiplyMoney(1.5, 33.33)).toBe(50);
  });
});

describe('allocateMoney (largest remainder)', () => {
  it('gives the missing cent to the first of equal parts', () => {
    expect(allocateMoney(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(allocateMoney(200, [1, 1, 1])).toEqual([66.67, 66.67, 66.66]);
    expect(allocateMoney(0.05, [1, 1])).toEqual([0.03, 0.02]);
  });

  it('gives the cent to the largest cut-off fraction', () => {
    // exact: 31.428.. / 42.857.. / 25.714.. -> fractions .8 / .7 / .4
    expect(allocateMoney(100, [11, 15, 9])).toEqual([31.43, 42.86, 25.71]);
  });

  it('breaks ties by the larger weight', () => {
    // exact 0.015 / 0.005 / 0 -> both have .5, the larger part wins
    expect(allocateMoney(0.02, [3, 1, 0])).toEqual([0.02, 0, 0]);
    expect(allocateMoney(0.01, [1, 3])).toEqual([0, 0.01]);
  });

  it('always adds up exactly', () => {
    const weights = [3.33, 7, 0.01, 12.5, 99.99, 0.5];
    [0.01, 1, 33.33, 100, 999.99, 123456.78].forEach((total) => {
      expect(sum(allocateMoney(total, weights))).toBe(roundMoney(total));
    });
  });

  it('handles zero, negative and mixed weights', () => {
    expect(allocateMoney(100, [])).toEqual([]);
    expect(allocateMoney(100, [0, 0])).toEqual([50, 50]);
    expect(allocateMoney(0, [1, 2])).toEqual([0, 0]);
    expect(allocateMoney(100, [1, 0, 1])).toEqual([50, 0, 50]);
    expect(allocateMoney(-100, [1, 1, 1])).toEqual([-33.33, -33.33, -33.34]);
    expect(sum(allocateMoney(-100, [1, 1, 1]))).toBe(-100);

    // Lines and a negative discount: 100 + 100 - 20 = 180.
    const parts = allocateMoney(90, [100, 100, -20]);
    expect(parts).toEqual([50, 50, -10]);
    expect(sum(allocateMoney(100, [100, 100, -20]))).toBe(100);
  });

  it('returns the weights themselves when the total equals their sum', () => {
    const lines = [33.33, 0.01, 1250.75, -10.5];
    expect(allocateMoney(sum(lines), lines)).toEqual(lines);
  });
});

describe('allocateCumulative (running total)', () => {
  it('ends every line exactly: 3 x 100 paid in three payments of 100', () => {
    const lines = [100, 100, 100];
    const p1 = allocateCumulative(0, 100, lines);
    const p2 = allocateCumulative(100, 100, lines);
    const p3 = allocateCumulative(200, 100, lines);

    expect(p1).toEqual([33.34, 33.33, 33.33]);
    expect(p2).toEqual([33.33, 33.34, 33.33]);
    expect(p3).toEqual([33.33, 33.33, 33.34]);
    [p1, p2, p3].forEach((part) => expect(sum(part)).toBe(100));
    lines.forEach((line, i) => expect(sum([p1[i], p2[i], p3[i]])).toBe(line));
  });

  it('ends exact with tax lines, a discount and 7 uneven payments', () => {
    // Income 1000, 333.33, tax 200, 50, discount -83.33, adjustment 0.01.
    const lines = [1000, 333.33, 200, 50, -83.33, 0.01];
    const total = sum(lines); // 1500.01
    const payments = [100, 0.01, 333.33, 250.5, 16.17, 700, 100];
    expect(sum(payments)).toBe(total);

    let paid = 0;
    const recognized = lines.map(() => 0);

    payments.forEach((payment) => {
      const parts = allocateCumulative(paid, payment, lines);
      expect(sum(parts)).toBe(payment);
      parts.forEach((part, i) => {
        recognized[i] = sumMoney(recognized[i], part);
      });
      paid = sumMoney(paid, payment);
    });
    expect(recognized).toEqual(lines);
  });

  it('gives the same result whatever the payments are split into', () => {
    const lines = [10.01, 20.02, 30.03];
    const once = allocateCumulative(0, 60.06, lines);
    expect(once).toEqual(lines);
  });
});

describe('calcLineMoney', () => {
  it('works out the plan example: 1.5 x 33.33, 2.5% discount, 15% exclusive', () => {
    expect(
      calcLineMoney({
        quantity: 1.5,
        rate: 33.33,
        discount: 2.5,
        discountType: 'percentage',
        taxRate: 15,
      }),
    ).toEqual({
      amount: 50,
      discountAmount: 1.25,
      taxableAmount: 48.75,
      taxAmount: 7.31,
      totalExcludingTax: 48.75,
      total: 56.06,
    });
  });

  it('taxes the amount after the line discount', () => {
    const line = calcLineMoney({
      quantity: 1,
      rate: 33.33,
      discount: 10,
      discountType: 'percentage',
      taxRate: 15,
    });
    expect(line).toEqual({
      amount: 33.33,
      discountAmount: 3.33,
      taxableAmount: 30,
      taxAmount: 4.5,
      totalExcludingTax: 30,
      total: 34.5,
    });
  });

  it('supports a fixed discount amount', () => {
    const line = calcLineMoney({
      quantity: 2,
      rate: 50,
      discount: 10.005,
      discountType: 'amount',
      taxRate: 10,
    });
    expect(line.discountAmount).toBe(10.01);
    expect(line.taxableAmount).toBe(89.99);
    expect(line.taxAmount).toBe(9);
    expect(line.total).toBe(98.99);
  });

  it('splits an inclusive tax out of the taxable amount', () => {
    const line = calcLineMoney({
      quantity: 1,
      rate: 1000,
      taxRate: 10,
      isInclusiveTax: true,
    });
    // 1000 x 10 / 110 = 90.909..
    expect(line).toEqual({
      amount: 1000,
      discountAmount: 0,
      taxableAmount: 1000,
      taxAmount: 90.91,
      totalExcludingTax: 909.09,
      total: 1000,
    });
  });

  it('rounds the half-cent cases away from zero', () => {
    // 0.5 x 0.01 = 0.005 -> 0.01
    expect(calcLineMoney({ quantity: 0.5, rate: 0.01 }).amount).toBe(0.01);
    // 15% of 0.10 = 0.015 -> 0.02
    expect(
      calcLineMoney({ quantity: 1, rate: 0.1, taxRate: 15 }).taxAmount,
    ).toBe(0.02);
    // 10% of 0.05 = 0.005 -> 0.01
    expect(
      calcLineMoney({ quantity: 1, rate: 0.05, discount: 10 }).discountAmount,
    ).toBe(0.01);
  });

  it('treats empty values as zero', () => {
    expect(calcLineMoney({ quantity: '', rate: null })).toEqual({
      amount: 0,
      discountAmount: 0,
      taxableAmount: 0,
      taxAmount: 0,
      totalExcludingTax: 0,
      total: 0,
    });
  });

  it('adds up per line to the invoice of the plan (3 x 33.33, 10% off, 15%)', () => {
    const lines = [1, 2, 3].map(() =>
      calcLineMoney({ quantity: 1, rate: 33.33, discount: 10, taxRate: 15 }),
    );
    expect(sumMoneyBy(lines, 'totalExcludingTax')).toBe(90);
    expect(sumMoneyBy(lines, 'taxAmount')).toBe(13.5);
    expect(sumMoneyBy(lines, 'total')).toBe(103.5);
  });
});

describe('calcDiscountMoney', () => {
  it('rounds a document discount', () => {
    expect(calcDiscountMoney(333.33, 10, 'percentage')).toBe(33.33);
    expect(calcDiscountMoney(100, 2.5, 'percentage')).toBe(2.5);
    expect(calcDiscountMoney(100, 12.345, 'amount')).toBe(12.35);
    expect(calcDiscountMoney(100, null)).toBe(0);
  });
});

describe('balanceEntries', () => {
  it('rounds and keeps a balanced set balanced', () => {
    const result = balanceEntries([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 },
    ]);
    expect(result.balanced).toBe(true);
    expect(result.pluggedIndex).toBe(-1);
  });

  it('puts the rounding leftover on the largest allowed line', () => {
    const entries = [
      { debit: 100, credit: 0, kind: 'receivable' },
      { debit: 0, credit: 33.333, kind: 'income' },
      { debit: 0, credit: 33.333, kind: 'income' },
      { debit: 0, credit: 33.334, kind: 'tax' },
    ];
    const result = balanceEntries(entries, {
      canAbsorb: (entry) => entry.kind === 'income',
    });
    expect(result.leftoverCents).toBe(1);
    expect(result.balanced).toBe(true);
    expect(result.pluggedIndex).toBe(1);
    expect(result.entries.map((e) => [e.debit, e.credit])).toEqual([
      [100, 0],
      [0, 33.34],
      [0, 33.33],
      [0, 33.33],
    ]);
  });

  it('shrinks a debit line when credits exceed debits', () => {
    const result = balanceEntries([
      { debit: 3795.896, credit: 0 },
      { debit: 0, credit: 3795.904 },
    ]);
    // 3795.90 vs 3795.90 -> already balanced after rounding
    expect(result.balanced).toBe(true);

    const second = balanceEntries(
      [
        { debit: 0, credit: 10.006, side: 'bank' },
        { debit: 5.002, credit: 0, side: 'expense' },
        { debit: 5.002, credit: 0, side: 'expense' },
      ],
      { canAbsorb: (entry) => entry.side === 'expense' },
    );
    // 10.01 credit vs 5.00 + 5.00 debit -> leftover -1 cent
    expect(second.leftoverCents).toBe(-1);
    expect(second.entries[1].debit).toBe(5.01);
    expect(second.balanced).toBe(true);
  });

  it('does not hide a real difference', () => {
    const result = balanceEntries([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 90 },
    ]);
    expect(result.balanced).toBe(false);
    expect(result.leftoverCents).toBe(1000);
    expect(result.entries[1].credit).toBe(90);
  });

  it('reports a set with no line allowed to absorb', () => {
    const result = balanceEntries(
      [
        { debit: 10.005, credit: 0 },
        { debit: 0, credit: 10.004 },
      ],
      { canAbsorb: () => false },
    );
    expect(result.balanced).toBe(false);
    expect(result.leftoverCents).toBe(1);
  });
});

describe('hasAtMostDecimals', () => {
  it.each([
    [100, true],
    [100.5, true],
    [100.55, true],
    [100.005, false],
    [0.001, false],
    [null, true],
  ])('%p -> %p', (value, expected) => {
    expect(hasAtMostDecimals(value as any)).toBe(expected);
  });
});
