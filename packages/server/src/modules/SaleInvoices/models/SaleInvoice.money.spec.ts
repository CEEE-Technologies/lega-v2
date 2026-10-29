import { SaleInvoice } from './SaleInvoice';
import { Bill } from '@/modules/Bills/models/Bill';

const invoice = (attrs: Partial<SaleInvoice>) =>
  Object.assign(Object.create(SaleInvoice.prototype), {
    balance: 0,
    paymentAmount: 0,
    writtenoffAmount: 0,
    creditedAmount: 0,
    discount: 0,
    discountType: 'amount',
    adjustment: 0,
    taxAmountWithheld: 0,
    isInclusiveTax: false,
    exchangeRate: 1,
    ...attrs,
  }) as SaleInvoice;

const bill = (attrs: Partial<Bill>) =>
  Object.assign(Object.create(Bill.prototype), {
    amount: 0,
    paymentAmount: 0,
    creditedAmount: 0,
    discount: 0,
    discountType: 'amount',
    adjustment: 0,
    taxAmountWithheld: 0,
    isInclusiveTax: false,
    exchangeRate: 1,
    ...attrs,
  }) as Bill;

describe('SaleInvoice paid status in cents', () => {
  it('is fully paid when 1.10 + 2.20 is paid on a 3.30 invoice', () => {
    const inv = invoice({ balance: 3.3, paymentAmount: 1.1 + 2.2 });
    expect(inv.dueAmount).toBe(0);
    expect(inv.isFullyPaid).toBe(true);
    expect(inv.isPartiallyPaid).toBe(false);
  });

  it('treats a sub-cent leftover as paid', () => {
    const inv = invoice({ balance: 909.091, paymentAmount: 909.09 });
    expect(inv.isFullyPaid).toBe(true);
  });

  it('counts the tax and adjustment as still due', () => {
    const inv = invoice({
      balance: 1000,
      taxAmountWithheld: 150,
      paymentAmount: 1000,
    });
    expect(inv.dueAmount).toBe(150);
    expect(inv.isPartiallyPaid).toBe(true);
    expect(inv.isFullyPaid).toBe(false);
  });
});

describe('Bill paid status in cents', () => {
  it('is fully paid when 0.1 + 0.2 is paid on a 0.30 bill', () => {
    const b = bill({ amount: 0.3, paymentAmount: 0.1, creditedAmount: 0.2 });
    expect(b.dueAmount).toBe(0);
    expect(b.isFullyPaid).toBe(true);
  });

  it('is partially paid while the adjustment is owed', () => {
    const b = bill({ amount: 1000, adjustment: 150, paymentAmount: 1000 });
    expect(b.dueAmount).toBe(150);
    expect(b.isPartiallyPaid).toBe(true);
  });
});
