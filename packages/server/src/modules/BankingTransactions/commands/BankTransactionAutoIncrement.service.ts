import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { AutoIncrementOrdersService } from '../../AutoIncrementOrders/AutoIncrementOrders.service';

@Injectable()
export class BankTransactionAutoIncrement {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique invoice number.
   * @return {string}
   */
  public getNextTransactionNumber = (): Promise<string> => {
    return this.autoIncrementOrdersService.getNextTransactionNumber('cashflow');
  };

  /**
   * Picks the bank transaction number inside the bank transaction save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The bank transaction save transaction.
   */
  public reserveTransactionNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'cashflow',
      givenNumber,
      trx,
    );
  }
}
