import {
  ContactOpeningBalancePayment,
  getOpeningBalancePaidAmount,
} from './ContactOpeningBalancePayment.service';
import {
  OPENING_BALANCE_ERRORS,
  normalizePaymentEntryType,
  validateOpeningBalanceNotBelowPaid,
} from './ContactOpeningBalance.constants';

const ob = (paymentAmount: number) => ({
  entryType: 'opening_balance',
  paymentAmount,
});
const inv = (paymentAmount: number) => ({
  entryType: 'invoice',
  paymentAmount,
});

/**
 * Builds the service over a fake contact model that records the queries.
 */
const buildService = (contact: Record<string, any> | null) => {
  const calls = { forUpdate: 0, increments: [] as any[], trx: [] as any[] };
  const contactModel = () => ({
    query: (trx) => {
      calls.trx.push(trx);
      return {
        findById: (id: number) => ({
          forUpdate: async () => {
            calls.forUpdate += 1;
            return contact;
          },
          increment: async (column: string, amount: number) => {
            calls.increments.push({ id, column, amount });
          },
        }),
      };
    },
  });
  const service = new ContactOpeningBalancePayment(contactModel as any);
  return { service, calls };
};

describe('getOpeningBalancePaidAmount', () => {
  it('sums only the opening balance lines, rounded to cents', () => {
    expect(
      getOpeningBalancePaidAmount([ob(100.1115), inv(50), ob(0.2)] as any),
    ).toBe(100.31);
    expect(getOpeningBalancePaidAmount(null)).toBe(0);
  });
});

describe('ContactOpeningBalancePayment.validateOpeningBalanceEntries', () => {
  const trx = { trx: true } as any;
  const customer = { openingBalance: 300, openingBalancePaymentAmount: 100 };

  it('does nothing (and locks nothing) without an opening balance line', async () => {
    const { service, calls } = buildService(customer);

    await service.validateOpeningBalanceEntries(
      { contactId: 1, entries: [inv(100)] as any },
      null,
      trx,
    );
    expect(calls.forUpdate).toBe(0);
  });

  it('locks the contact row and accepts up to the opening balance due', async () => {
    const { service, calls } = buildService(customer);

    await service.validateOpeningBalanceEntries(
      { contactId: 1, entries: [ob(200)] as any },
      null,
      trx,
    );
    expect(calls.forUpdate).toBe(1);
    expect(calls.trx).toEqual([trx]);
  });

  it('rejects more than the opening balance due', async () => {
    const { service } = buildService(customer);

    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(200.01)] as any },
        null,
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
      payload: { dueAmount: 200 },
    });
  });

  it("adds back the edited payment's own opening balance amount", async () => {
    const { service } = buildService({
      openingBalance: 300,
      openingBalancePaymentAmount: 300,
    });
    await service.validateOpeningBalanceEntries(
      { contactId: 1, entries: [ob(250)] as any },
      { contactId: 1, entries: [ob(250)] as any },
      trx,
    );
    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(260)] as any },
        { contactId: 1, entries: [ob(250)] as any },
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
    });
  });

  it("doesn't add back the old amount when the contact changed", async () => {
    const { service } = buildService({
      openingBalance: 300,
      openingBalancePaymentAmount: 300,
    });
    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 2, entries: [ob(10)] as any },
        { contactId: 1, entries: [ob(250)] as any },
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
    });
  });

  it('rejects two opening balance lines', async () => {
    const { service } = buildService(customer);

    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(10), ob(10)] as any },
        null,
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_ENTRY_DUPLICATE,
    });
  });

  it('rejects a contact without an opening balance', async () => {
    const { service } = buildService({
      openingBalance: 0,
      openingBalancePaymentAmount: 0,
    });
    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(10)] as any },
        null,
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_NOT_FOUND,
    });
  });

  it('rejects a negative amount', async () => {
    const { service } = buildService(customer);

    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(-5)] as any },
        null,
        trx,
      ),
    ).rejects.toMatchObject({
      errorType: OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
    });
  });

  it('accepts decimals paying the due exactly', async () => {
    const { service } = buildService({
      openingBalance: 100.555,
      openingBalancePaymentAmount: 0,
    });
    await expect(
      service.validateOpeningBalanceEntries(
        { contactId: 1, entries: [ob(100.555)] as any },
        null,
        trx,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('ContactOpeningBalancePayment.syncPaidAmount', () => {
  const trx = { trx: true } as any;

  it('adds the opening balance line on create', async () => {
    const { service, calls } = buildService(null);

    await service.syncPaidAmount(
      { contactId: 7, entries: [ob(300), inv(100)] as any },
      null,
      trx,
    );
    expect(calls.increments).toEqual([
      { id: 7, column: 'opening_balance_payment_amount', amount: 300 },
    ]);
    expect(calls.trx).toEqual([trx]);
  });

  it('applies only the difference on edit', async () => {
    const { service, calls } = buildService(null);

    await service.syncPaidAmount(
      { contactId: 7, entries: [ob(50)] as any },
      { contactId: 7, entries: [ob(100)] as any },
      trx,
    );
    expect(calls.increments).toEqual([
      { id: 7, column: 'opening_balance_payment_amount', amount: -50 },
    ]);
  });

  it('removes it on delete, and changes nothing when unchanged', async () => {
    const deleted = buildService(null);
    await deleted.service.syncPaidAmount(
      null,
      { contactId: 7, entries: [ob(100)] as any },
      trx,
    );
    expect(deleted.calls.increments).toEqual([
      { id: 7, column: 'opening_balance_payment_amount', amount: -100 },
    ]);

    const unchanged = buildService(null);
    await unchanged.service.syncPaidAmount(
      { contactId: 7, entries: [ob(100), inv(5)] as any },
      { contactId: 7, entries: [ob(100)] as any },
      trx,
    );
    expect(unchanged.calls.increments).toEqual([]);
  });

  it('moves the paid amount when the contact changes', async () => {
    const { service, calls } = buildService(null);

    await service.syncPaidAmount(
      { contactId: 8, entries: [ob(40)] as any },
      { contactId: 7, entries: [ob(100)] as any },
      trx,
    );
    expect(calls.increments).toEqual([
      { id: 8, column: 'opening_balance_payment_amount', amount: 40 },
      { id: 7, column: 'opening_balance_payment_amount', amount: -100 },
    ]);
  });
});

describe('validateOpeningBalanceNotBelowPaid', () => {
  it('rejects a new opening balance below the paid amount', () => {
    expect(() => validateOpeningBalanceNotBelowPaid(150, 200)).toThrow(
      "Payments already paid 200 of the opening balance; it can't be set to 150.",
    );
  });

  it('accepts the paid amount itself, more, or anything when nothing is paid', () => {
    expect(() => validateOpeningBalanceNotBelowPaid(200, 200)).not.toThrow();
    expect(() => validateOpeningBalanceNotBelowPaid(500, 200)).not.toThrow();
    expect(() => validateOpeningBalanceNotBelowPaid(0, 0)).not.toThrow();
  });
});

describe('normalizePaymentEntryType', () => {
  it('defaults to an invoice line and clears the document of opening balance lines', () => {
    expect(
      normalizePaymentEntryType({ invoiceId: 3 } as any, 'invoiceId'),
    ).toEqual({
      invoiceId: 3,
      entryType: 'invoice',
    });
    expect(
      normalizePaymentEntryType(
        { entryType: 'opening_balance', billId: 9 } as any,
        'billId',
      ),
    ).toEqual({ entryType: 'opening_balance', billId: null });
  });
});
