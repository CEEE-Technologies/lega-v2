import { getCreditApplicationAdjustment } from './CreditApplications';

const base = {
  paidOnDocument: 0,
  creditedBefore: 0,
  appliedBefore: 0,
};

describe('getCreditApplicationAdjustment', () => {
  it("Codex's case: EUR 100.02 at 1.5, credit 50.01 at 1.5 then pay 50.01", () => {
    // The invoice posted 150.03; the credit 50.01 (75.02 at its rate).
    const credit = getCreditApplicationAdjustment({
      ...base,
      amount: 50.01,
      documentRate: 1.5,
      creditRate: 1.5,
    });
    // As the first settlement: round(50.01 x 1.5) = 75.02, no adjustment;
    // the payment then relieves round(50.01 x 1.5) = 75.02 too...
    expect(credit).toEqual({
      documentRelief: 75.02,
      creditPart: 75.02,
      adjustment: 0,
    });
    // ...but on top of the payments it is the remainder: 150.03 - 75.02.
    const afterPayment = getCreditApplicationAdjustment({
      ...base,
      amount: 50.01,
      documentRate: 1.5,
      creditRate: 1.5,
      paidOnDocument: 50.01,
    });
    expect(afterPayment).toEqual({
      documentRelief: 75.01,
      creditPart: 75.02,
      adjustment: 0.01,
    });
  });

  it('posts the rate difference: invoice 50.01 at 1.5, credit at 1.6 (gain) or 1.4 (loss)', () => {
    expect(
      getCreditApplicationAdjustment({
        ...base,
        amount: 50.01,
        documentRate: 1.5,
        creditRate: 1.6,
      }),
    ).toEqual({ documentRelief: 75.02, creditPart: 80.02, adjustment: 5 });
    expect(
      getCreditApplicationAdjustment({
        ...base,
        amount: 50.01,
        documentRate: 1.5,
        creditRate: 1.4,
      }),
    ).toEqual({ documentRelief: 75.02, creditPart: 70.01, adjustment: -5.01 });
  });

  it('runs the credit part over the credit applications', () => {
    // Credit EUR 0.03 at 1.5 (0.05) over three invoices of 0.01: 0.02, 0.01, 0.02.
    const parts = [0, 0.01, 0.02].map(
      (appliedBefore) =>
        getCreditApplicationAdjustment({
          ...base,
          amount: 0.01,
          documentRate: 1.5,
          creditRate: 1.5,
          appliedBefore,
        }).creditPart,
    );
    expect(parts).toEqual([0.02, 0.01, 0.02]);
  });

  it('is 0 at rate 1', () => {
    expect(
      getCreditApplicationAdjustment({
        ...base,
        amount: 33.33,
        documentRate: 1,
        creditRate: 1,
        paidOnDocument: 10,
        creditedBefore: 5,
      }).adjustment,
    ).toBe(0);
  });
});
