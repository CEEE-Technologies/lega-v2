import { PaymentReceivedCashGL } from './PaymentReceivedCashGL';
import { PaymentReceived } from '../models/PaymentReceived';
import { AccountingBasis } from '@/common/types/AccountingBasis';

interface TestItemEntry {
  itemId?: number;
  description?: string;
  sellAccountId: number;
  totalExcludingTax: number;
  taxAmount?: number;
  taxRateId?: number | null;
  taxRate?: number;
}

interface TestInvoice {
  id: number;
  exchangeRate: number;
  totalLocal: number;
  entries: TestItemEntry[];
  discountAmountLocal?: number | null;
  adjustmentLocal?: number | null;
}

const buildItemEntry = (
  overrides: Partial<TestItemEntry> = {},
): TestItemEntry => ({
  itemId: 1,
  description: 'Item description',
  sellAccountId: 500,
  totalExcludingTax: 1000,
  taxAmount: 0,
  taxRateId: null,
  taxRate: 0,
  ...overrides,
});

const buildInvoice = (
  entries: TestItemEntry[],
  overrides: Partial<TestInvoice> = {},
): TestInvoice & {
  total: number;
  discountAmount: number;
  adjustment: number;
} => {
  const invoice = {
    id: 10,
    exchangeRate: 1,
    totalLocal: entries.reduce(
      (total, entry) =>
        total + entry.totalExcludingTax + (entry.taxAmount || 0),
      0,
    ),
    discountAmountLocal: null,
    adjustmentLocal: null,
    entries,
    ...overrides,
  };
  // The invoice currency figures the running-total split uses.
  const rate = invoice.exchangeRate || 1;
  return {
    ...invoice,
    total: invoice.totalLocal / rate,
    discountAmount: (invoice.discountAmountLocal || 0) / rate,
    adjustment: (invoice.adjustmentLocal || 0) / rate,
  };
};

const buildPayment = () =>
  ({
    id: 1,
    paymentReceiveNo: 'PAY-00001',
    referenceNo: 'REF-00001',
    paymentDate: '2024-01-01',
    currencyCode: 'USD',
    exchangeRate: 1,
    userId: 1,
    branchId: 1,
    createdAt: '2024-01-01',
    depositAccountId: 100,
    customerId: 5,
    entries: [],
  }) as unknown as PaymentReceived;

const buildPaymentEntry = (invoice: any, paymentAmount: number) => ({
  invoiceId: invoice.id,
  paymentAmount,
  invoice,
});

const buildGL = (payment: PaymentReceived) =>
  new PaymentReceivedCashGL(payment)
    .setTaxPayableAccountId(200)
    .setDiscountAccountId(300)
    .setOtherChargesAccountId(400);

const findEntry = (entries: any[], accountId: number) =>
  entries.find((entry) => entry.accountId === accountId);

describe('PaymentReceivedCashGL', () => {
  it('records Dr deposit / Cr income for a full tax-free payment', () => {
    const invoice = buildInvoice([buildItemEntry()], { totalLocal: 1000 });
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 1000)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    expect(entries).toHaveLength(2);

    const depositEntry = findEntry(entries, 100);
    expect(depositEntry.debit).toBe(1000);
    expect(depositEntry.credit).toBe(0);
    expect(depositEntry.accountNormal).toBe('debit');

    const incomeEntry = findEntry(entries, 500);
    expect(incomeEntry.credit).toBe(1000);
    expect(incomeEntry.debit).toBe(0);
    expect(incomeEntry.accountNormal).toBe('credit');
  });

  it('flags the entries as cash basis with its own index group', () => {
    const invoice = buildInvoice([buildItemEntry()], { totalLocal: 1000 });
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 1000)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    entries.forEach((entry) => {
      expect(entry.basis).toBe(AccountingBasis.Cash);
      expect(entry.indexGroup).toBe(50);
      expect(entry.transactionType).toBe('PaymentReceive');
      expect(entry.transactionId).toBe(payment.id);
    });
  });

  it('mirrors the invoice tax payable for a tax-exclusive invoice', () => {
    const invoice = buildInvoice(
      [
        buildItemEntry({
          totalExcludingTax: 1000,
          taxAmount: 100,
          taxRateId: 7,
          taxRate: 10,
        }),
      ],
      { totalLocal: 1100 },
    );
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 1100)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    expect(entries).toHaveLength(3);
    expect(findEntry(entries, 100).debit).toBe(1100);
    expect(findEntry(entries, 500).credit).toBe(1000);

    const taxEntry = findEntry(entries, 200);
    expect(taxEntry.credit).toBe(100);
    expect(taxEntry.taxRateId).toBe(7);
    expect(taxEntry.taxRate).toBe(10);
  });

  it('recognizes the income proportionally for a partial payment', () => {
    const invoice = buildInvoice([buildItemEntry()], { totalLocal: 1000 });
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 400)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    expect(findEntry(entries, 100).debit).toBe(400);
    expect(findEntry(entries, 500).credit).toBe(400);
  });

  it('mirrors the invoice discount and adjustment entries', () => {
    const invoice = buildInvoice([buildItemEntry()], {
      totalLocal: 950,
      discountAmountLocal: 100,
      adjustmentLocal: 50,
    });
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 950)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    expect(entries).toHaveLength(4);
    expect(findEntry(entries, 100).debit).toBe(950);
    expect(findEntry(entries, 500).credit).toBe(1000);
    expect(findEntry(entries, 300).debit).toBe(100);
    expect(findEntry(entries, 400).credit).toBe(50);
  });

  it('records the income of each invoice of a multi-invoices payment', () => {
    const invoiceA = buildInvoice([buildItemEntry({ sellAccountId: 500 })], {
      id: 10,
      totalLocal: 1000,
    });
    const invoiceB = buildInvoice(
      [buildItemEntry({ sellAccountId: 501, totalExcludingTax: 500 })],
      {
        id: 11,
        totalLocal: 500,
      },
    );
    const payment = {
      ...buildPayment(),
      entries: [
        buildPaymentEntry(invoiceA, 1000),
        buildPaymentEntry(invoiceB, 500),
      ],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    expect(entries).toHaveLength(4);
    expect(findEntry(entries, 500).credit).toBe(1000);
    expect(findEntry(entries, 501).credit).toBe(500);
    expect(
      entries
        .filter((entry) => entry.accountId === 100)
        .reduce((total, entry) => total + entry.debit, 0),
    ).toBe(1500);
  });

  it('keeps the cash basis entries balanced', () => {
    const invoice = buildInvoice(
      [
        buildItemEntry({ totalExcludingTax: 1000, taxAmount: 100 }),
        buildItemEntry({
          sellAccountId: 501,
          totalExcludingTax: 500,
          taxAmount: 50,
        }),
      ],
      { id: 10, totalLocal: 1550, discountAmountLocal: 100 },
    );
    const payment = {
      ...buildPayment(),
      entries: [buildPaymentEntry(invoice, 825)],
    } as unknown as PaymentReceived;

    const entries = buildGL(payment).GLEntries();

    const totalDebit = entries.reduce((total, entry) => total + entry.debit, 0);
    const totalCredit = entries.reduce(
      (total, entry) => total + entry.credit,
      0,
    );
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
    expect(findEntry(entries, 100).debit).toBe(825);
  });
});

describe('PaymentReceivedCashGL — unapplied amount (excess)', () => {
  const UNEARNED_REVENUE = 700;
  const OTHER_INCOME = 800;
  const BANK = 100;

  const buildExcessGL = (payment: PaymentReceived) =>
    buildGL(payment).setUnearnedRevenueAccountId(UNEARNED_REVENUE);

  const sum = (entries: any[], key: 'debit' | 'credit') =>
    Math.round(entries.reduce((total, e) => total + e[key], 0) * 100) / 100;

  const sumAccount = (
    entries: any[],
    accountId: number,
    key: 'debit' | 'credit',
  ) =>
    sum(
      entries.filter((e) => e.accountId === accountId),
      key,
    );

  // PAY-0002: 290,000 received, 200,000 + 20,000 applied, 70,000 unapplied.
  const buildPay0002 = () => {
    const invoiceA = buildInvoice(
      [buildItemEntry({ totalExcludingTax: 200000 })],
      { id: 1 },
    );
    const invoiceB = buildInvoice(
      [buildItemEntry({ totalExcludingTax: 20000 })],
      { id: 2 },
    );

    return {
      ...buildPayment(),
      amount: 290000,
      entries: [
        buildPaymentEntry(invoiceA, 200000),
        buildPaymentEntry(invoiceB, 20000),
      ],
    } as unknown as PaymentReceived;
  };

  it('posts the excess to unearned revenue when there is no opening balance', () => {
    const gl = buildExcessGL(buildPay0002());
    const entries = gl.GLEntries();

    expect(gl.getExcessAmount()).toBe(70000);
    expect(sumAccount(entries, BANK, 'debit')).toBe(290000);
    expect(sumAccount(entries, 500, 'credit')).toBe(220000);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(70000);
    expect(entries.filter((e) => e.accountId === OTHER_INCOME)).toHaveLength(0);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  // Plan example: opening balance 300, invoice 100, payment 550.
  const buildOpeningBalancePayment = (openingBalancePaid = 300) => {
    const invoice = buildInvoice([buildItemEntry({ totalExcludingTax: 100 })], {
      id: 1,
    });
    return {
      ...buildPayment(),
      amount: 550,
      entries: [
        {
          entryType: 'opening_balance',
          invoiceId: null,
          paymentAmount: openingBalancePaid,
          invoice: null,
        },
        { ...buildPaymentEntry(invoice, 100), entryType: 'invoice' },
      ],
    } as unknown as PaymentReceived;
  };

  it('credits the opening balance account with the opening balance line, only the true excess is unearned', () => {
    const gl = buildExcessGL(
      buildOpeningBalancePayment(),
    ).setOpeningBalanceAccountId(OTHER_INCOME);
    const entries = gl.GLEntries();

    expect(gl.hasOpeningBalanceEntries()).toBe(true);
    expect(gl.getExcessAmount()).toBe(150);
    expect(sumAccount(entries, BANK, 'debit')).toBe(550);
    expect(sumAccount(entries, OTHER_INCOME, 'credit')).toBe(300);
    expect(sumAccount(entries, 500, 'credit')).toBe(100);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(150);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('tags the opening balance lines with the customer', () => {
    const entries = buildExcessGL(buildOpeningBalancePayment())
      .setOpeningBalanceAccountId(OTHER_INCOME)
      .GLEntries();
    const obLine = entries.find((e) => e.accountId === OTHER_INCOME);

    expect(obLine.contactId).toBe(5);
    expect(obLine.basis).toBe(AccountingBasis.Cash);
  });

  it('posts everything not applied to unearned revenue when the opening balance line is 0', () => {
    const entries = buildExcessGL(buildOpeningBalancePayment(0))
      .setOpeningBalanceAccountId(OTHER_INCOME)
      .GLEntries();

    expect(entries.filter((e) => e.accountId === OTHER_INCOME)).toHaveLength(0);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(450);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('keeps the bank line (as unearned) when the opening balance account is unknown', () => {
    const entries = buildExcessGL(buildOpeningBalancePayment()).GLEntries();

    expect(sumAccount(entries, BANK, 'debit')).toBe(550);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(450);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('records a payment of the opening balance only (no invoice)', () => {
    const payment = {
      ...buildPayment(),
      amount: 100.555,
      entries: [
        {
          entryType: 'opening_balance',
          invoiceId: null,
          paymentAmount: 100.555,
          invoice: null,
        },
      ],
    } as unknown as PaymentReceived;
    const gl = buildExcessGL(payment).setOpeningBalanceAccountId(OTHER_INCOME);
    const entries = gl.GLEntries();

    expect(gl.getExcessAmount()).toBe(0);
    expect(entries).toHaveLength(2);
    expect(sumAccount(entries, BANK, 'debit')).toBe(100.56);
    expect(sumAccount(entries, OTHER_INCOME, 'credit')).toBe(100.56);
  });

  it('keeps the bank line when the invoice total is zero', () => {
    const invoice = buildInvoice([buildItemEntry({ totalExcludingTax: 0 })], {
      totalLocal: 0,
    });
    const payment = {
      ...buildPayment(),
      amount: 500,
      entries: [buildPaymentEntry(invoice, 500)],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(sumAccount(entries, BANK, 'debit')).toBe(500);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(500);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('keeps the bank line when the invoice is missing', () => {
    const payment = {
      ...buildPayment(),
      amount: 500,
      entries: [{ invoiceId: 99, paymentAmount: 500, invoice: null }],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(sumAccount(entries, BANK, 'debit')).toBe(500);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(500);
  });

  it('posts no excess lines when the whole amount is applied', () => {
    const invoice = buildInvoice([buildItemEntry()]);
    const payment = {
      ...buildPayment(),
      amount: 1000,
      entries: [buildPaymentEntry(invoice, 1000)],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(
      entries.filter((e) => e.accountId === UNEARNED_REVENUE),
    ).toHaveLength(0);
    expect(sumAccount(entries, BANK, 'debit')).toBe(1000);
  });

  it('splits a full payment of 100 over 3 lines with the largest remainder', () => {
    const invoice = buildInvoice(
      [
        buildItemEntry({ sellAccountId: 501, totalExcludingTax: 33.33 }),
        buildItemEntry({ sellAccountId: 502, totalExcludingTax: 33.33 }),
        buildItemEntry({ sellAccountId: 503, totalExcludingTax: 33.34 }),
      ],
      { totalLocal: 100 },
    );
    const payment = {
      ...buildPayment(),
      amount: 100,
      entries: [buildPaymentEntry(invoice, 100)],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(findEntry(entries, 501).credit).toBe(33.33);
    expect(findEntry(entries, 502).credit).toBe(33.33);
    expect(findEntry(entries, 503).credit).toBe(33.34);
    expect(sum(entries, 'debit')).toBe(100);
    expect(sum(entries, 'credit')).toBe(100);
  });

  it('posts a payment above what is left to pay as unearned revenue', () => {
    const invoice = buildInvoice([buildItemEntry({ totalExcludingTax: 3 })]);
    const payment = {
      ...buildPayment(),
      amount: 100,
      entries: [buildPaymentEntry(invoice, 100)],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(findEntry(entries, 500).credit).toBe(3);
    expect(sumAccount(entries, UNEARNED_REVENUE, 'credit')).toBe(97);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('balances every set (multi-invoice, tax, discount, excess, opening balance)', () => {
    const invoiceA = buildInvoice(
      [
        buildItemEntry({ totalExcludingTax: 1000, taxAmount: 170 }),
        buildItemEntry({
          sellAccountId: 501,
          totalExcludingTax: 333.33,
          taxAmount: 56.67,
        }),
      ],
      { id: 1, totalLocal: 1460, discountAmountLocal: 100 },
    );
    const invoiceB = buildInvoice(
      [buildItemEntry({ totalExcludingTax: 777.77 })],
      { id: 2 },
    );
    const payment = {
      ...buildPayment(),
      amount: 2000,
      entries: [
        buildPaymentEntry(invoiceA, 777.77),
        buildPaymentEntry(invoiceB, 333.33),
        {
          entryType: 'opening_balance',
          invoiceId: null,
          paymentAmount: 300,
          invoice: null,
        },
      ],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment)
      .setOpeningBalanceAccountId(OTHER_INCOME)
      .GLEntries();

    entries.forEach((e) => {
      expect(Math.round(e.debit * 100) / 100).toBe(e.debit);
      expect(Math.round(e.credit * 100) / 100).toBe(e.credit);
    });
    expect(sumAccount(entries, BANK, 'debit')).toBe(2000);
    expect(sumAccount(entries, OTHER_INCOME, 'credit')).toBe(300);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });
});

describe('PaymentReceivedCashGL — running-total split (cumulative)', () => {
  const INCOME = [501, 502, 503];
  const sum = (entries: any[], key: 'debit' | 'credit') =>
    Math.round(entries.reduce((total, e) => total + e[key], 0) * 100) / 100;
  const sumAccount = (
    entries: any[],
    accountId: number,
    key: 'debit' | 'credit',
  ) =>
    sum(
      entries.filter((e) => e.accountId === accountId),
      key,
    );
  const invoice3x100 = () =>
    buildInvoice(
      INCOME.map((sellAccountId) =>
        buildItemEntry({ sellAccountId, totalExcludingTax: 100 }),
      ),
    );
  const pay = (invoice: any, amount: number, paidBefore: number, id = 1) =>
    buildGL({
      ...buildPayment(),
      id,
      amount,
      entries: [buildPaymentEntry(invoice, amount)],
    } as unknown as PaymentReceived)
      .setPaidBefore({ [invoice.id]: paidBefore })
      .GLEntries();
  const incomeOf = (entries: any[]) =>
    INCOME.map((accountId) => findEntry(entries, accountId).credit);

  it('ends every line at exactly 100: 3 x 100 paid in three payments of 100', () => {
    const invoice = invoice3x100();
    const p1 = incomeOf(pay(invoice, 100, 0, 1));
    const p2 = incomeOf(pay(invoice, 100, 100, 2));
    const p3 = incomeOf(pay(invoice, 100, 200, 3));

    expect(p1).toEqual([33.34, 33.33, 33.33]);
    expect(p2).toEqual([33.33, 33.34, 33.33]);
    expect(p3).toEqual([33.33, 33.33, 33.34]);
    INCOME.forEach((_, i) =>
      expect(Math.round((p1[i] + p2[i] + p3[i]) * 100) / 100).toBe(100),
    );
  });

  it('still ends exact when the middle payment is deleted or re-dated', () => {
    const invoice = invoice3x100();
    // Payments of 100 then 200 (the middle one deleted, the last re-sized),
    // and the same two in the other order.
    [
      [100, 200],
      [200, 100],
    ].forEach(([first, second]) => {
      const a = incomeOf(pay(invoice, first, 0));
      const b = incomeOf(pay(invoice, second, first));
      INCOME.forEach((_, i) =>
        expect(Math.round((a[i] + b[i]) * 100) / 100).toBe(100),
      );
    });
  });

  it('splits a multi-invoice payment invoice by invoice', () => {
    const invoiceA = { ...invoice3x100(), id: 10 };
    const invoiceB = buildInvoice(
      [buildItemEntry({ sellAccountId: 600, totalExcludingTax: 50 })],
      { id: 11 } as any,
    );
    const entries = buildGL({
      ...buildPayment(),
      amount: 150,
      entries: [
        buildPaymentEntry(invoiceA, 100),
        buildPaymentEntry(invoiceB, 50),
      ],
    } as unknown as PaymentReceived)
      .setPaidBefore({ 10: 200, 11: 0 })
      .GLEntries();

    // Invoice A: the last 100 of 300 completes its lines.
    expect(incomeOf(entries)).toEqual([33.33, 33.33, 33.34]);
    expect(findEntry(entries, 600).credit).toBe(50);
    expect(sum(entries, 'debit')).toBe(150);
    expect(sum(entries, 'credit')).toBe(150);
  });

  it('includes the tax, discount and adjustment and ends exact (7 payments)', () => {
    const invoice = buildInvoice(
      [
        buildItemEntry({
          sellAccountId: 501,
          totalExcludingTax: 1000,
          taxAmount: 150,
        }),
        buildItemEntry({ sellAccountId: 502, totalExcludingTax: 333.33 }),
      ],
      {
        totalLocal: 1000 + 150 + 333.33 - 83.33 + 0.01,
        discountAmountLocal: 83.33,
        adjustmentLocal: 0.01,
      },
    );
    const payments = [100, 0.01, 333.33, 250.5, 16.17, 600, 100];
    let paid = 0;
    const totals: Record<string, number> = {};
    const add = (key: string, value: number) => {
      totals[key] = Math.round(((totals[key] || 0) + value) * 100) / 100;
    };
    payments.forEach((amount) => {
      const entries = pay(invoice, amount, paid);
      expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
      add('501', findEntry(entries, 501)?.credit || 0);
      add('502', findEntry(entries, 502)?.credit || 0);
      add(
        'tax',
        sumAccount(entries, 200, 'credit') - sumAccount(entries, 200, 'debit'),
      );
      add(
        'discount',
        sumAccount(entries, 300, 'debit') - sumAccount(entries, 300, 'credit'),
      );
      add(
        'adjustment',
        sumAccount(entries, 400, 'credit') - sumAccount(entries, 400, 'debit'),
      );
      paid = Math.round((paid + amount) * 100) / 100;
    });
    expect(paid).toBe(1400.01);
    expect(totals).toEqual({
      '501': 1000,
      '502': 333.33,
      tax: 150,
      discount: 83.33,
      adjustment: 0.01,
    });
  });
});

// Codex: converting each invoice's share on its own made the bank lines add
// up to a cent more or less than the accrual bank line, round(amount x rate).
describe('PaymentReceivedCashGL — bank lines add up to the accrual bank line', () => {
  const sumCents = (entries: any[], accountId: number, side: string) =>
    entries
      .filter((entry) => entry.accountId === accountId)
      .reduce(
        (total, entry) => total + Math.round((entry[side] || 0) * 100),
        0,
      );

  const foreignInvoice = (id: number, total: number, rate: number) =>
    buildInvoice([buildItemEntry({ totalExcludingTax: total })], {
      id,
      exchangeRate: rate,
      totalLocal: Math.round(total * rate * 100) / 100,
    });

  const glOf = (rate: number, amount: number, entries: any[]) =>
    buildGL({
      ...buildPayment(),
      exchangeRate: rate,
      amount,
      entries,
    } as unknown as PaymentReceived)
      .setUnearnedRevenueAccountId(600)
      .setExchangeGainOrLossAccountId(700)
      .setOpeningBalanceAccountId(800);

  const expectBalanced = (entries: any[]) =>
    expect(entries.reduce((t, e) => t + Math.round(e.debit * 100), 0)).toBe(
      entries.reduce((t, e) => t + Math.round(e.credit * 100), 0),
    );

  it('0.02 at 1.5 split 0.01 + 0.01 posts 0.03 to the bank, not 0.04', () => {
    const a = foreignInvoice(11, 0.01, 1.5);
    const b = foreignInvoice(12, 0.01, 1.5);
    const gl = glOf(1.5, 0.02, [
      buildPaymentEntry(a, 0.01),
      buildPaymentEntry(b, 0.01),
    ]);
    const entries = gl.GLEntries();
    expect(sumCents(entries, 100, 'debit')).toBe(3);
    expect(gl.getExcessAmount()).toBe(0);
    expect(findEntry(entries, 600)).toBeUndefined();
    expectBalanced(entries);
  });

  it('USD 100.02 at 300.005 over 3 invoices of 33.34 posts 30,006.50', () => {
    const invoices = [21, 22, 23].map((id) =>
      foreignInvoice(id, 33.34, 300.005),
    );
    const gl = glOf(
      300.005,
      100.02,
      invoices.map((invoice) => buildPaymentEntry(invoice, 33.34)),
    );
    const entries = gl.GLEntries();
    expect(sumCents(entries, 100, 'debit')).toBe(3000650);
    expect(gl.getExcessAmount()).toBe(0);
    expectBalanced(entries);
    // Income ends at the converted invoices; the cent is exchange gain/loss.
    expect(sumCents(entries, 500, 'credit')).toBe(3 * 1000217);
  });

  it('includes the opening balance and the excess in the split', () => {
    const invoices = [31, 32].map((id) => foreignInvoice(id, 33.34, 300.005));
    const gl = glOf(300.005, 100.03, [
      ...invoices.map((invoice) => buildPaymentEntry(invoice, 33.34)),
      {
        entryType: 'opening_balance',
        invoiceId: null,
        paymentAmount: 0.01,
        invoice: null,
      },
    ]);
    const entries = gl.GLEntries();
    // round(100.03 x 300.005) = 30,009.50
    expect(sumCents(entries, 100, 'debit')).toBe(3000950);
    expect(gl.getExcessAmount()).toBeGreaterThan(0);
    expect(sumCents(entries, 600, 'credit')).toBe(
      Math.round(gl.getExcessAmount() * 100),
    );
    expectBalanced(entries);
  });

  it('keeps the base currency split exact', () => {
    const a = buildInvoice([buildItemEntry({ totalExcludingTax: 33.33 })], {
      id: 41,
      totalLocal: 33.33,
    });
    const b = buildInvoice([buildItemEntry({ totalExcludingTax: 66.67 })], {
      id: 42,
      totalLocal: 66.67,
    });
    const entries = glOf(1, 100.5, [
      buildPaymentEntry(a, 33.33),
      buildPaymentEntry(b, 66.67),
    ]).GLEntries();
    const bank = entries.filter((e) => e.accountId === 100).map((e) => e.debit);
    expect(bank).toEqual([33.33, 66.67, 0.5]);
  });
});

// Codex: a payment that converts to 0.00 (EUR 0.01 at 0.4) was not
// recognized, so an invoice paid as 3 x EUR 0.01 never had its income
// (EUR 0.03 = USD 0.01) recognized in cash basis.
describe('PaymentReceivedCashGL — payments that convert to zero', () => {
  const cents = (value: number) => Math.round((value || 0) * 100);

  it('recognizes EUR 0.03 at 0.4 paid as 3 x 0.01 on the payment where the cent crosses', () => {
    const invoice = buildInvoice(
      [buildItemEntry({ totalExcludingTax: 0.03 })],
      {
        id: 51,
        exchangeRate: 0.4,
        totalLocal: 0.01,
      },
    );
    let paid = 0;
    let income = 0;
    let bank = 0;
    let exchange = 0;
    for (let i = 0; i < 3; i += 1) {
      const entries = buildGL({
        ...buildPayment(),
        exchangeRate: 0.4,
        amount: 0.01,
        entries: [buildPaymentEntry(invoice, 0.01)],
      } as unknown as PaymentReceived)
        .setUnearnedRevenueAccountId(600)
        .setExchangeGainOrLossAccountId(700)
        .setPaidBefore({ 51: paid })
        .GLEntries();
      const sum = (accountId: number, side: string) =>
        entries
          .filter((e) => e.accountId === accountId)
          .reduce((t, e) => t + cents(e[side]), 0);
      expect(entries.reduce((t, e) => t + cents(e.debit), 0)).toBe(
        entries.reduce((t, e) => t + cents(e.credit), 0),
      );
      // Nothing goes to unearned revenue: the payment pays the invoice.
      expect(sum(600, 'credit')).toBe(0);
      income += sum(500, 'credit') - sum(500, 'debit');
      bank += sum(100, 'debit') - sum(100, 'credit');
      exchange += sum(700, 'debit') - sum(700, 'credit');
      paid = Math.round((paid + 0.01) * 100) / 100;
    }
    // Accrual income is USD 0.01; each bank line is round(0.004) = 0.00.
    expect(income).toBe(1);
    expect(bank).toBe(0);
    expect(exchange).toBe(1);
  });
});
