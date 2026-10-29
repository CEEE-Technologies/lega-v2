import { ApplyVendorCreditToBillsService } from './ApplyVendorCreditToBills.service';
import { ERRORS } from '../VendorCreditsApplyBills.constants';

// The validator is an arrow property set by the constructor; the
// dependencies are not used by it.
const validate = (bills: any[], entries: any[]) =>
  new (ApplyVendorCreditToBillsService as any)(
    ...Array(10).fill(() => ({})),
  ).validateBillsRemainingAmount(bills, entries);

describe('ApplyVendorCreditToBills — bills remaining amount', () => {
  it('compares each bill with its own line, not the total applied', () => {
    // 300 applied in total, but each bill only gets 150 of it.
    expect(() =>
      validate(
        [
          { id: 1, dueAmount: 200 },
          { id: 2, dueAmount: 200 },
        ],
        [
          { billId: 1, amount: 150 },
          { billId: 2, amount: 150 },
        ],
      ),
    ).not.toThrow();
  });

  it('rejects a line above its bill due, in cents', () => {
    expect(() =>
      validate([{ id: 1, dueAmount: 1.1 + 2.2 }], [{ billId: 1, amount: 3.3 }]),
    ).not.toThrow();
    expect(() =>
      validate([{ id: 1, dueAmount: 3.3 }], [{ billId: 1, amount: 3.305 }]),
    ).toThrow(
      expect.objectContaining({
        errorType: ERRORS.BILLS_HAS_NO_REMAINING_AMOUNT,
      }),
    );
  });
});
