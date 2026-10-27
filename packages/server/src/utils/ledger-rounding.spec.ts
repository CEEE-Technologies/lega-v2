import {
  roundLedgerAmount,
  roundLedgerEntries,
  splitLedgerAmount,
} from './ledger-rounding';

const sum = (
  entries: { debit: number; credit: number }[],
  key: 'debit' | 'credit',
) => Math.round(entries.reduce((total, e) => total + e[key], 0) * 1000) / 1000;

describe('ledger-rounding', () => {
  it('rounds to 3 decimals', () => {
    expect(roundLedgerAmount(33.33333)).toBe(33.333);
    expect(roundLedgerAmount(0.0005)).toBe(0.001);
    expect(roundLedgerAmount(undefined)).toBe(0);
  });

  it('splits 100 three ways with the remainder on the last part', () => {
    expect(splitLedgerAmount(100, [1, 1, 1])).toEqual([33.333, 33.333, 33.334]);
    expect(splitLedgerAmount(100, [])).toEqual([]);
    expect(splitLedgerAmount(100, [0, 0])).toEqual([0, 100]);
  });

  it('puts the rounding remainder of a set on the last credit line', () => {
    const entries = roundLedgerEntries([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 / 3 },
      { debit: 0, credit: 100 / 3 },
      { debit: 0, credit: 100 / 3 },
    ]);
    expect(entries.map((e) => e.credit)).toEqual([0, 33.333, 33.333, 33.334]);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('shrinks the last debit line when that is the last non-zero line', () => {
    const entries = roundLedgerEntries([
      { debit: 0, credit: 100 },
      { debit: 200 / 3, credit: 0 },
      { debit: 100 / 3, credit: 0 },
    ]);
    expect(entries.map((e) => e.debit)).toEqual([0, 66.667, 33.333]);
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
