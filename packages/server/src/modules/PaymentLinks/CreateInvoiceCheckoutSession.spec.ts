import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { CreateInvoiceCheckoutSession } from './CreateInvoiceCheckoutSession';

/**
 * The Stripe checkout charges what is still owed on the invoice, in whole
 * cents. It charged the full total (so a part-paid invoice was charged
 * again in full and the payment then failed), and built the cents with
 * float maths (19.99 * 100 = 1998.9999999999998, which Stripe rejects).
 */
describe('CreateInvoiceCheckoutSession — amount charged', () => {
  const sessionFor = async (row: Record<string, any>) => {
    const create = jest.fn().mockResolvedValue({ id: 'cs_1', url: 'u' });
    const service = new CreateInvoiceCheckoutSession(
      { stripe: { checkout: { sessions: { create } } } } as any,
      null,
      null,
      null,
      null,
      null,
    );
    const invoice = SaleInvoice.fromJson(
      { id: 1, invoiceNo: 'INV-1', currencyCode: 'USD', ...row } as any,
      { skipValidation: true },
    );
    await (service as any).createCheckoutSession(invoice, 'acct_1', {});
    return create.mock.calls[0][0].line_items[0].price_data.unit_amount;
  };

  it('charges the amount due, not the total', async () => {
    // Total 100, 60 paid: 40.00 left.
    expect(await sessionFor({ balance: 100, paymentAmount: 60 })).toBe(4000);
  });

  it('sends whole cents', async () => {
    expect(await sessionFor({ balance: 19.99 })).toBe(1999);
    expect(await sessionFor({ balance: 1.15 })).toBe(115);
  });
});
