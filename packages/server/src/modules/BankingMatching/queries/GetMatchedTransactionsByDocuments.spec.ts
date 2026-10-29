import { Bill } from '@/modules/Bills/models/Bill';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { GetMatchedTransactionsByBills } from './GetMatchedTransactionsByBills.service';
import { GetMatchedTransactionsByInvoices } from './GetMatchedTransactionsByInvoices.service';

/**
 * Bank matching suggests a bill or invoice for the amount still due: the
 * amount the match is checked against and the payment it then creates.
 * Bills showed the subtotal (before discount, adjustment and tax) and fully
 * paid bills; invoices left out every part-paid invoice.
 */
describe('Bank matching — suggested documents and amounts', () => {
  // The transformer runs the transformer's amount() on each document.
  const transformer: any = {
    transform: jest.fn(async (items: any[], t: any) =>
      items.map((item) => ({ id: item.id, amount: t.amount(item) })),
    ),
  };
  const modelOf = (rows: any[]) =>
    (() => ({
      query: () => ({ onBuild: async () => rows }),
    })) as any;

  it('suggests bills for the amount due, and only bills still due', async () => {
    const bills = [
      // Subtotal 100, 10% off, 15 tax: 105 due (was suggested at 100).
      {
        id: 1,
        amount: 100,
        discount: 10,
        discountType: 'percentage',
        taxAmountWithheld: 15,
      },
      // Part paid: 45 of 105 left.
      {
        id: 2,
        amount: 100,
        discount: 10,
        discountType: 'percentage',
        taxAmountWithheld: 15,
        paymentAmount: 60,
      },
      // Fully paid: not suggested (was suggested at 100).
      { id: 3, amount: 100, paymentAmount: 100 },
    ].map((row) => Bill.fromJson(row as any, { skipValidation: true }));
    const service = new GetMatchedTransactionsByBills(
      null,
      transformer,
      modelOf(bills),
      null,
    );
    expect(await service.getMatchedTransactions({} as any)).toEqual([
      { id: 1, amount: 105 },
      { id: 2, amount: 45 },
    ]);
  });

  it('suggests every invoice still due, part paid included', async () => {
    const invoices = [
      { id: 1, balance: 100, paymentAmount: 0 },
      // Part paid: was left out (the filter wanted no payment at all).
      { id: 2, balance: 100, paymentAmount: 40 },
      // Settled by a credit note: was suggested at 0.
      { id: 3, balance: 100, creditedAmount: 100 },
    ].map((row) => SaleInvoice.fromJson(row as any, { skipValidation: true }));
    const service = new GetMatchedTransactionsByInvoices(
      transformer,
      null,
      modelOf(invoices),
      null,
    );
    expect(await service.getMatchedTransactions({} as any)).toEqual([
      { id: 1, amount: 100 },
      { id: 2, amount: 60 },
    ]);
  });
});
