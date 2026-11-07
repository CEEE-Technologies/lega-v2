import { ValidateMatchingOnPaymentMadeDeleteSubscriber } from './ValidateMatchingOnPaymentMadeDelete';

/**
 * Matches save a bill payment as `BillPayment`, so the delete guard must
 * look for that type (it looked only for `PaymentMade` and never fired).
 */
describe('ValidateMatchingOnPaymentMadeDeleteSubscriber', () => {
  it('refuses deleting a bill payment linked to a bank line', async () => {
    const validator = {
      validateTransactionNoMatchLinking: jest.fn(async (type: string) => {
        if (type === 'BillPayment') throw new Error('matched');
      }),
    };
    const subscriber = new ValidateMatchingOnPaymentMadeDeleteSubscriber(
      validator as any,
    );
    await expect(
      subscriber.validateMatchingOnPaymentMadeDeleting({
        oldBillPayment: { id: 13 },
        trx: undefined,
      } as any),
    ).rejects.toThrow('matched');
    expect(validator.validateTransactionNoMatchLinking).toHaveBeenCalledWith(
      'BillPayment',
      13,
      undefined,
    );
  });
});
