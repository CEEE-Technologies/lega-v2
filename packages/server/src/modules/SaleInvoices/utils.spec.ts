import { transformInvoiceToPdfTemplate } from './utils';

/** Sweep S4: the invoice PDF shows the adjustment its total includes. */
describe('transformInvoiceToPdfTemplate', () => {
  it('passes the adjustment', () => {
    const attrs = transformInvoiceToPdfTemplate({
      dueDateFormatted: '2026 Jun 30',
      invoiceDateFormatted: '2026 Jun 1',
      invoiceNo: 'INV-1',
      totalFormatted: '$110.00',
      subtotalFormatted: '$100.00',
      balanceAmountFormatted: '$0.00',
      dueAmountFormatted: '$110.00',
      adjustmentFormatted: '$10.00',
      discountAmountFormatted: '$0.00',
      discountPercentageFormatted: '',
      entries: [],
      taxes: [],
      customer: {},
    } as any);
    expect(attrs.adjustment).toBe('$10.00');
    expect(attrs.total).toBe('$110.00');
  });
});
