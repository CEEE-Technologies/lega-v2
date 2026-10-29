import { Ledger } from './Ledger';
import { transformLedgerEntryToTransaction } from './utils';

/**
 * Codex P1: foreign balances (contacts and accounts in another currency)
 * divided each cent-rounded base amount by the rate. A EUR 0.02 invoice at
 * 1.5 (0.03 base) paid as 2 x EUR 0.01 (0.02 base each, the 0.01 rounding
 * going to exchange gain/loss) left 0.03/1.5 - 2 x 0.02/1.5 = -0.0067 EUR.
 * They now add up the stored transaction currency amounts.
 */
const line = (overrides: Record<string, any>) =>
  ({
    debit: 0,
    credit: 0,
    currencyCode: 'EUR',
    exchangeRate: 1.5,
    accountNormal: 'debit',
    accountId: 10,
    contactId: 5,
    transactionType: 'SaleInvoice',
    transactionId: 1,
    date: '2026-01-01',
    index: 1,
    ...overrides,
  }) as any;

describe('Ledger — foreign closing balance', () => {
  it("closes Codex's EUR 0.02 invoice paid as 2 x 0.01 at exactly 0", () => {
    const ledger = new Ledger([
      line({ debit: 0.03, foreignDebit: 0.02 }),
      line({
        credit: 0.02,
        foreignCredit: 0.01,
        transactionType: 'PaymentReceive',
      }),
      line({
        credit: 0.02,
        foreignCredit: 0.01,
        transactionType: 'PaymentReceive',
        transactionId: 2,
      }),
    ]);
    expect(ledger.getForeignClosingBalance()).toBe(0);
    // The old division left -0.0067.
    const legacy = new Ledger([
      line({ debit: 0.03 }),
      line({ credit: 0.02 }),
      line({ credit: 0.02 }),
    ]);
    expect(legacy.getForeignClosingBalance()).toBeCloseTo(-0.00667, 5);
  });

  it('keeps a rate below 1 exact (USD home, LKR contact at 0.0033)', () => {
    // LKR 1,001 is 3.30 USD; LKR 1 is 0.00 USD, but still LKR 1.
    const ledger = new Ledger([
      line({
        currencyCode: 'LKR',
        exchangeRate: 0.0033,
        debit: 3.3,
        foreignDebit: 1001,
      }),
      line({
        currencyCode: 'LKR',
        exchangeRate: 0.0033,
        credit: 3.3,
        foreignCredit: 1000,
      }),
    ]);
    expect(ledger.getForeignClosingBalance()).toBe(1);
  });

  it('reverses the foreign amounts with the base ones', () => {
    const ledger = new Ledger([line({ debit: 0.03, foreignDebit: 0.02 })]);
    const reversed = ledger.reverse();
    expect(reversed.getEntries()[0]).toEqual(
      expect.objectContaining({
        credit: 0.03,
        foreignCredit: 0.02,
        foreignDebit: undefined,
      }),
    );
    expect(reversed.getForeignClosingBalance()).toBe(-0.02);
  });

  it('stores the base amounts as foreign amounts at rate 1, and none otherwise', () => {
    expect(
      transformLedgerEntryToTransaction(
        line({ exchangeRate: 1, currencyCode: 'USD', debit: 12.34 }),
      ),
    ).toEqual(
      expect.objectContaining({ foreignDebit: 12.34, foreignCredit: 0 }),
    );
    expect(transformLedgerEntryToTransaction(line({ debit: 0.03 }))).toEqual(
      expect.objectContaining({ foreignDebit: null, foreignCredit: null }),
    );
    expect(
      transformLedgerEntryToTransaction(
        line({ debit: 0.03, foreignDebit: 0.02 }),
      ),
    ).toEqual(
      expect.objectContaining({ foreignDebit: 0.02, foreignCredit: 0 }),
    );
  });

  it('gives an exchange gain/loss line no foreign amount', () => {
    const ledger = new Ledger([
      line({ debit: 0.03, foreignDebit: 0.02 }),
      line({
        credit: 0.01,
        foreignDebit: 0,
        foreignCredit: 0,
        exchangeRate: 1,
      }),
    ]);
    expect(ledger.getForeignClosingBalance()).toBe(0.02);
  });
});
