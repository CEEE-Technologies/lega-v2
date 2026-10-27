import { BillPaymentValidators } from './BillPaymentValidators.service';
import { ERRORS } from '../constants';

const makeValidators = () =>
  new BillPaymentValidators(
    (() => ({})) as any,
    (() => ({})) as any,
    (() => ({})) as any,
    (() => ({})) as any,
  );

describe('BillPaymentValidators.validateEntriesWithinAmount', () => {
  const validators = makeValidators();

  it('accepts lines that add up to the amount paid', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { paymentAmount: 150000 },
        { paymentAmount: 50000 },
      ]),
    ).not.toThrow();
  });

  it('accepts lines below the amount paid (the rest is unapplied)', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { paymentAmount: 150000 },
      ]),
    ).not.toThrow();
  });

  it('rejects lines that add up to more than the amount paid', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { paymentAmount: 150000 },
        { paymentAmount: 60000 },
      ]),
    ).toThrow(
      expect.objectContaining({
        errorType: ERRORS.PAYMENT_ENTRIES_EXCEED_AMOUNT,
      }),
    );
  });

  it('ignores floating point noise', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(0.3, [
        { paymentAmount: 0.1 },
        { paymentAmount: 0.2 },
      ]),
    ).not.toThrow();
  });

  it('accepts string amounts and no lines', () => {
    expect(() =>
      validators.validateEntriesWithinAmount('100' as any, [
        { paymentAmount: '100' as any },
      ]),
    ).not.toThrow();
    expect(() => validators.validateEntriesWithinAmount(100)).not.toThrow();
  });
});

describe('BillPaymentValidators — opening balance lines', () => {
  const ob = { entryType: 'opening_balance', billId: null, paymentAmount: 400 };

  // Bill query stub: `query().whereIn().where().forUpdate()` resolves to bills.
  const billModelReturning = (bills: any[]) => () => ({
    query: () => {
      const builder: any = Promise.resolve(bills);
      builder.whereIn = jest.fn(() => builder);
      builder.where = () => builder;
      builder.forUpdate = () => builder;
      return builder;
    },
  });
  const makeBillValidators = (bills: any[]) =>
    new BillPaymentValidators(
      billModelReturning(bills) as any,
      (() => ({})) as any,
      (() => ({})) as any,
      (() => ({})) as any,
    );

  it('skips the opening balance line when checking the bills exist', async () => {
    const validators = makeBillValidators([{ id: 3, openedAt: '2026-03-01' }]);
    await expect(
      validators.validateBillsExistance(
        [ob, { billId: 3, paymentAmount: 500 }] as any,
        7,
      ),
    ).resolves.toHaveLength(1);
    await expect(
      validators.validateBillsExistance([ob] as any, 7),
    ).resolves.toEqual([]);
  });

  it('skips the opening balance line when checking the bills due amounts', async () => {
    const validators = makeBillValidators([{ id: 3, dueAmount: 500 }]);

    await expect(
      validators.validateBillsDueAmount(
        [ob, { billId: 3, paymentAmount: 500 }] as any,
        [],
      ),
    ).resolves.toBeUndefined();
  });
});
