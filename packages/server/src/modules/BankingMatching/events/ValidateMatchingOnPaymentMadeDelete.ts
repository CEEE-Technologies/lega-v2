import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ValidateTransactionMatched } from '../commands/ValidateTransactionsMatched.service';
import { IBillPaymentEventDeletedPayload } from '@/modules/BillPayments/types/BillPayments.types';
import { events } from '@/common/events/events';

@Injectable()
export class ValidateMatchingOnPaymentMadeDeleteSubscriber {
  constructor(
    private readonly validateNoMatchingLinkedService: ValidateTransactionMatched,
  ) {}

  /**
   * Validates the payment made transaction whether matched with bank transaction on deleting.
   * @param {IPaymentReceivedDeletedPayload}
   */
  @OnEvent(events.billPayment.onDeleting)
  public async validateMatchingOnPaymentMadeDeleting({
    oldBillPayment,
    trx,
  }: IBillPaymentEventDeletedPayload) {
    // Matches save a bill payment as `BillPayment`; `PaymentMade` is kept
    // for any link saved under the old name.
    for (const referenceType of ['BillPayment', 'PaymentMade']) {
      await this.validateNoMatchingLinkedService.validateTransactionNoMatchLinking(
        referenceType,
        oldBillPayment.id,
        trx,
      );
    }
  }
}
