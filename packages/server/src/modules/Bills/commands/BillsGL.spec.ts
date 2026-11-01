import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { BillGL } from './BillsGL';

const buildBill = (overrides: Record<string, any> = {}) =>
  ({
    id: 1,
    exchangeRate: 1,
    currencyCode: 'USD',
    userId: 1,
    referenceNo: 'REF-1',
    billNumber: 'B-100',
    billDate: '2023-01-01',
    branchId: 1,
    projectId: null,
    createdAt: new Date('2023-01-01'),
    discountType: 'amount',
    discount: 0,
    adjustment: 0,
    entries: [
      {
        id: 1,
        itemId: 10,
        totalExcludingTax: 1000,
        costAccountId: null,
        item: { type: 'inventory', inventoryAccountId: 100 },
      },
      {
        id: 2,
        itemId: 11,
        totalExcludingTax: 500,
        costAccountId: 200,
        item: { type: 'service' },
      },
    ],
    ...overrides,
  }) as any;

const buildLedger = (bill: any) =>
  new BillGL(bill)
    .setPayableAccountId(1)
    .setTaxPayableAccountId(2)
    .setPurchaseDiscountAccountId(3)
    .setOtherExpensesAccountId(4)
    .getBillLedger();

/**
 * P7: the bill's entries used to add the landed costs allocated to it,
 * while the landed cost posts them in its own set too, so a re-saved bill
 * counted them twice. The bill's entries are its own lines only.
 */
describe('BillGL', () => {
  it('posts each item line at its own amount, without allocated landed costs', () => {
    const ledger = buildLedger(buildBill());

    const entries = ledger.getEntries();
    const itemEntryOne = entries.find((entry) => entry.itemId === 10);
    const itemEntryTwo = entries.find((entry) => entry.itemId === 11);

    expect(itemEntryOne.debit).toBe(1000);
    expect(itemEntryOne.accountId).toBe(100);
    expect(itemEntryOne.indexGroup).toBe(10);
    expect(itemEntryOne.accountNormal).toBe(AccountNormal.DEBIT);

    expect(itemEntryTwo.debit).toBe(500);
    expect(itemEntryTwo.accountId).toBe(200);
    expect(entries.some((entry) => entry.accountId === 300)).toBe(false);
  });

  it('applies the exchange rate to the item entries', () => {
    const ledger = buildLedger(buildBill({ exchangeRate: 2 }));

    const entries = ledger.getEntries();
    const itemEntryOne = entries.find((entry) => entry.itemId === 10);

    expect(itemEntryOne.debit).toBe(2000);
  });
});
