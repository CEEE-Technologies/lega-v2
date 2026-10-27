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
): TestInvoice => ({
  id: 10,
  exchangeRate: 1,
  totalLocal: entries.reduce(
    (total, entry) => total + entry.totalExcludingTax + (entry.taxAmount || 0),
    0,
  ),
  discountAmountLocal: null,
  adjustmentLocal: null,
  entries,
  ...overrides,
});

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

const buildPaymentEntry = (invoice: TestInvoice, paymentAmount: number) => ({
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
    Math.round(entries.reduce((total, e) => total + e[key], 0) * 1000) / 1000;

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
    expect(sumAccount(entries, BANK, 'debit')).toBe(100.555);
    expect(sumAccount(entries, OTHER_INCOME, 'credit')).toBe(100.555);
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

  it('rounds pro-rata lines and puts the remainder on the last line (100 over 3)', () => {
    const invoice = buildInvoice(
      [
        buildItemEntry({ sellAccountId: 501, totalExcludingTax: 1 }),
        buildItemEntry({ sellAccountId: 502, totalExcludingTax: 1 }),
        buildItemEntry({ sellAccountId: 503, totalExcludingTax: 1 }),
      ],
      { totalLocal: 3 },
    );
    const payment = {
      ...buildPayment(),
      amount: 100,
      entries: [buildPaymentEntry(invoice, 100)],
    } as unknown as PaymentReceived;
    const entries = buildExcessGL(payment).GLEntries();

    expect(findEntry(entries, 501).credit).toBe(33.333);
    expect(findEntry(entries, 502).credit).toBe(33.333);
    expect(findEntry(entries, 503).credit).toBe(33.334);
    expect(sum(entries, 'debit')).toBe(100);
    expect(sum(entries, 'credit')).toBe(100);
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
      expect(Math.round(e.debit * 1000) / 1000).toBe(e.debit);
      expect(Math.round(e.credit * 1000) / 1000).toBe(e.credit);
    });
    expect(sumAccount(entries, BANK, 'debit')).toBe(2000);
    expect(sumAccount(entries, OTHER_INCOME, 'credit')).toBe(300);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });
});
