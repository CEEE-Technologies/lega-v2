import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { SaleInvoiceWriteoffGL } from './SaleInvoiceWriteoffGL';
import { SaleInvoice } from '../../models/SaleInvoice';

const AR_ACCOUNT_ID = 10007;
const BAD_DEBT_ACCOUNT_ID = 1024;

const buildSaleInvoice = (overrides: Record<string, any> = {}) =>
  ({
    id: 1,
    invoiceDate: '2023-01-01',
    currencyCode: 'USD',
    exchangeRate: 1,
    invoiceNo: 'INV-100',
    referenceNo: 'REF-1',
    branchId: 1,
    customerId: 5,
    writtenoffAmountLocal: 1000,
    writtenoffExpenseAccountId: BAD_DEBT_ACCOUNT_ID,
    writtenoffExpenseAccount: { accountNormal: AccountNormal.DEBIT },
    ...overrides,
  }) as any;

const buildLedger = (saleInvoice: any) =>
  new SaleInvoiceWriteoffGL(saleInvoice)
    .setARAccountId(AR_ACCOUNT_ID)
    .getInvoiceWriteoffLedger();

describe('SaleInvoiceWriteoffGL', () => {
  it('credits the receivable and debits the bad debt expense', () => {
    const entries = buildLedger(buildSaleInvoice()).getEntries();

    const receivableEntry = entries.find(
      (entry) => entry.accountId === AR_ACCOUNT_ID,
    );
    const expenseEntry = entries.find(
      (entry) => entry.accountId === BAD_DEBT_ACCOUNT_ID,
    );

    expect(receivableEntry.credit).toBe(1000);
    expect(receivableEntry.debit).toBe(0);
    expect(receivableEntry.contactId).toBe(5);

    expect(expenseEntry.debit).toBe(1000);
    expect(expenseEntry.credit).toBe(0);
  });

  it('flags every ledger entry as accrual basis', () => {
    const entries = buildLedger(buildSaleInvoice()).getEntries();

    expect(entries).toHaveLength(2);
    expect(
      entries.every((entry) => entry.basis === AccountingBasis.Accrual),
    ).toBe(true);
  });
});

// Codex: the write-off's local amount was rounded on its own, while the
// payments relieve A/R with a running total at the invoice rate, so a
// written-off invoice left A/R a cent off.
describe('SaleInvoice.writtenoffAmountLocal — running total at the invoice rate', () => {
  const invoice = (fields: Record<string, number>) =>
    SaleInvoice.fromJson(
      { creditedAmount: 0, paymentAmount: 0, ...fields },
      { skipValidation: true },
    );

  it('EUR 0.02 at 1.5 paid 0.01: writes off 0.01, not 0.02 (A/R -0.01)', () => {
    // Posted 0.03; the payment relieved round(0.01 x 1.5) = 0.02.
    expect(
      invoice({
        exchangeRate: 1.5,
        paymentAmount: 0.01,
        writtenoffAmount: 0.01,
      }).writtenoffAmountLocal,
    ).toBe(0.01);
  });

  it('EUR 101.00 at 300.005 paid 50.50: writes off 15,150.26, not 15,150.25 (A/R +0.01)', () => {
    // Posted 30,300.51; the payment relieved 15,150.25.
    expect(
      invoice({
        exchangeRate: 300.005,
        paymentAmount: 50.5,
        writtenoffAmount: 50.5,
      }).writtenoffAmountLocal,
    ).toBe(15150.26);
  });

  it('counts the applied credits as settled before the write-off', () => {
    expect(
      invoice({
        exchangeRate: 1.5,
        paymentAmount: 0,
        creditedAmount: 0.01,
        writtenoffAmount: 0.01,
      }).writtenoffAmountLocal,
    ).toBe(0.01);
  });

  it('writes off the whole converted invoice when nothing was paid', () => {
    expect(
      invoice({ exchangeRate: 300.005, writtenoffAmount: 101 })
        .writtenoffAmountLocal,
    ).toBe(30300.51);
    expect(
      invoice({ exchangeRate: 1, writtenoffAmount: 99.99 })
        .writtenoffAmountLocal,
    ).toBe(99.99);
  });
});
