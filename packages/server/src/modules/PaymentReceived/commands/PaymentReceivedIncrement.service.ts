import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';

@Injectable()
export class PaymentReceivedIncrement {
  /**
   * @param {AutoIncrementOrdersService} autoIncrementOrdersService - Auto increment orders service.
   */
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique payment receive number.
   * @return {Promise<string>}
   */
  public getNextPaymentReceiveNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'payment_receives',
    );
  }

  /**
   * Picks the payment number inside the payment save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The payment save transaction.
   */
  public reservePaymentReceiveNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'payment_receives',
      givenNumber,
      trx,
    );
  }
}
