import {
  roundLedgerAmount,
  roundLedgerEntries,
  splitLedgerAmount,
} from './ledger-rounding';

const sum = (
  entries: { debit: number; credit: number }[],
  key: 'debit' | 'credit',
) => Math.round(entries.reduce((total, e) => total + e[key], 0) * 100) / 100;

describe('ledger-rounding', () => {
  it('rounds to cents, halves away from zero', () => {
    expect(roundLedgerAmount(33.33333)).toBe(33.33);
    expect(roundLedgerAmount(0.005)).toBe(0.01);
    expect(roundLedgerAmount(1.005)).toBe(1.01);
    expect(roundLedgerAmount(-0.125)).toBe(-0.13);
    expect(roundLedgerAmount(undefined)).toBe(0);
  });

  it('splits 100 three ways with the largest remainder method', () => {
    expect(splitLedgerAmount(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(splitLedgerAmount(100, [])).toEqual([]);
    expect(splitLedgerAmount(100, [0, 0])).toEqual([50, 50]);
  });

  it('puts the rounding remainder of a set on the last credit line', () => {
    const entries = roundLedgerEntries([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 / 3 },
      { debit: 0, credit: 100 / 3 },
      { debit: 0, credit: 100 / 3 },
    ]);
    expect(entries.map((e) => e.credit)).toEqual([0, 33.33, 33.33, 33.34]);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('shrinks the last debit line when that is the last non-zero line', () => {
    const entries = roundLedgerEntries([
      { debit: 0, credit: 100 },
      { debit: 200 / 3, credit: 0 },
      { debit: 100 / 3, credit: 0 },
    ]);
    expect(entries.map((e) => e.debit)).toEqual([0, 66.67, 33.33]);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('does not hide a difference bigger than rounding', () => {
    const entries = roundLedgerEntries([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 90 },
    ]);
    expect(entries[1].credit).toBe(90);
  });
});
