import { RefundCreditNoteGLEntries } from './RefundCreditNoteGLEntries';
import { RefundVendorCreditGLEntries } from '@/modules/VendorCreditsRefund/commands/RefundVendorCreditGLEntries';

/**
 * Codex review on #25: editing a foreign document's rate to 1, with its
 * refund at 1 too, rebuilt only the refund's cash entries, so the exchange
 * gain/loss posted at the old rate stayed. A foreign currency refund now
 * always gets its whole journal rebuilt; a base currency one only its cash
 * entries.
 */
const setup = (
  Service: any,
  documentKey: 'creditNote' | 'vendorCredit',
  refund: Record<string, any>,
) => {
  const query = {
    where: jest.fn(() => ({ orderBy: jest.fn(async () => [{ id: 1 }]) })),
    findById: jest.fn(() => ({
      withGraphFetched: jest.fn(async () => ({ id: 1, ...refund })),
    })),
  };
  const model = jest.fn(() => ({ query: jest.fn(() => query) }));
  const tenancyContext = {
    getTenantMetadata: jest.fn(async () => ({ baseCurrency: 'USD' })),
  };
  const service = new Service(
    {} as any,
    {} as any,
    (() => ({})) as any,
    model as any,
    tenancyContext as any,
  );
  const names =
    documentKey === 'creditNote'
      ? {
          all: 'rewriteCreditNoteRefundsGLEntries',
          whole: 'rewriteRefundCreditGLEntries',
          cash: 'rewriteRefundCreditCashGLEntries',
        }
      : {
          all: 'rewriteVendorCreditRefundsGLEntries',
          whole: 'rewriteRefundVendorCreditGLEntries',
          cash: 'rewriteRefundVendorCreditCashGLEntries',
        };
  const whole = jest.spyOn(service, names.whole).mockResolvedValue(undefined);
  const cash = jest.spyOn(service, names.cash).mockResolvedValue(undefined);
  return { run: () => service[names.all](7), whole, cash };
};

describe.each([
  ['credit note', RefundCreditNoteGLEntries, 'creditNote' as const],
  ['vendor credit', RefundVendorCreditGLEntries, 'vendorCredit' as const],
])('rewriting the refunds of an edited %s', (_name, Service, key) => {
  it('rebuilds the whole journal of a foreign refund when both rates are now 1', async () => {
    const { run, whole, cash } = setup(Service, key, {
      currencyCode: 'EUR',
      exchangeRate: 1,
      [key]: { currencyCode: 'EUR', exchangeRate: 1 },
    });
    await run();
    expect(whole).toHaveBeenCalledWith(1, undefined);
    expect(cash).not.toHaveBeenCalled();
  });

  it('rebuilds only the cash entries of a base currency refund', async () => {
    const { run, whole, cash } = setup(Service, key, {
      currencyCode: 'USD',
      exchangeRate: 1,
      [key]: { currencyCode: 'USD', exchangeRate: 1 },
    });
    await run();
    expect(cash).toHaveBeenCalledWith(1, undefined);
    expect(whole).not.toHaveBeenCalled();
  });
});
