import { PaymentReceivedValidators } from './PaymentReceivedValidators.service';
import { ERRORS } from '../constants';

// Invoice query stub: `query().whereIn().forUpdate()` resolves to the given invoices.
const invoiceModelReturning = (invoices: any[]) => () => ({
  query: () => {
    const builder: any = Promise.resolve(invoices);
    builder.whereIn = () => builder;
    builder.forUpdate = () => builder;
    return builder;
  },
});

const makeValidators = (invoices: any[] = []) =>
  new PaymentReceivedValidators(
    (() => ({})) as any,
    (() => ({})) as any,
    invoiceModelReturning(invoices) as any,
    (() => ({})) as any,
  );

describe('PaymentReceivedValidators.validateEntriesWithinAmount', () => {
  const validators = makeValidators();

  it('accepts lines that add up to the amount received', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { invoiceId: 1, paymentAmount: 130000 },
        { invoiceId: 2, paymentAmount: 70000 },
      ] as any),
    ).not.toThrow();
  });

  it('accepts lines below the amount received (excess payment)', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { invoiceId: 1, paymentAmount: 150000 },
      ] as any),
    ).not.toThrow();
  });

  it('rejects lines that add up to more than the amount received', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(200000, [
        { invoiceId: 1, paymentAmount: 200000 },
        { invoiceId: 2, paymentAmount: 70000 },
      ] as any),
    ).toThrow(
      expect.objectContaining({
        errorType: ERRORS.PAYMENT_ENTRIES_EXCEED_AMOUNT,
      }),
    );
  });

  it('ignores floating point noise', () => {
    expect(() =>
      validators.validateEntriesWithinAmount(0.3, [
        { invoiceId: 1, paymentAmount: 0.1 },
        { invoiceId: 2, paymentAmount: 0.2 },
      ] as any),
    ).not.toThrow();
  });
});

describe('PaymentReceivedValidators.validateInvoicesPaymentsAmount', () => {
  // #1005 fully paid by this payment (200,000); #1042 unpaid (70,000 due).
  const invoices = [
    { id: 1005, dueAmount: 0 },
    { id: 1042, dueAmount: 70000 },
  ];
  const oldEntries = [{ invoiceId: 1005, paymentAmount: 200000 }];

  it('frees up only the invoice’s own old line when editing', async () => {
    const validators = makeValidators(invoices);

    await expect(
      validators.validateInvoicesPaymentsAmount(
        [
          { invoiceId: 1005, paymentAmount: 200000 },
          { invoiceId: 1042, paymentAmount: 100000 },
        ] as any,
        oldEntries as any,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ errorType: ERRORS.INVALID_PAYMENT_AMOUNT }),
    );
  });

  it('allows re-saving the same lines', async () => {
    const validators = makeValidators(invoices);

    await expect(
      validators.validateInvoicesPaymentsAmount(
        [{ invoiceId: 1005, paymentAmount: 200000 }] as any,
        oldEntries as any,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('PaymentReceivedValidators — opening balance lines', () => {
  const ob = {
    entryType: 'opening_balance',
    invoiceId: null,
    paymentAmount: 300,
  };

  it('accepts a payment of the opening balance only (no invoice)', async () => {
    const validators = makeValidators([]);

    await expect(
      validators.validateInvoicesIDsExistance(5, [ob] as any),
    ).resolves.toEqual([]);
  });

  it('still rejects a payment with neither an invoice nor the opening balance', async () => {
    const validators = makeValidators([]);

    await expect(
      validators.validateInvoicesIDsExistance(5, [] as any),
    ).rejects.toEqual(
      expect.objectContaining({ errorType: ERRORS.INVOICES_IDS_NOT_FOUND }),
    );
  });

  it('checks the invoice due amounts without the opening balance line', async () => {
    const validators = makeValidators([{ id: 1042, dueAmount: 100 }]);

    await expect(
      validators.validateInvoicesPaymentsAmount(
        [ob, { invoiceId: 1042, paymentAmount: 100 }] as any,
        [],
      ),
    ).resolves.toBeUndefined();
    await expect(
      validators.validateInvoicesPaymentsAmount([ob] as any, []),
    ).resolves.toBeUndefined();
  });

  it('counts the opening balance line in the amount received', () => {
    const validators = makeValidators();

    expect(() =>
      validators.validateEntriesWithinAmount(350, [
        ob,
        { invoiceId: 1, paymentAmount: 100 },
      ] as any),
    ).toThrow();
  });
});
