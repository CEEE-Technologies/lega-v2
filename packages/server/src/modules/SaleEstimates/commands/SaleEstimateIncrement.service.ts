import { Knex } from 'knex';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SaleEstimateIncrement {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique estimate number.
   * @return {Promise<string>}
   */
  public getNextEstimateNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'sales_estimates',
    );
  }

  /**
   * Picks the estimate number inside the estimate save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The estimate save transaction.
   */
  public reserveEstimateNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'sales_estimates',
      givenNumber,
      trx,
    );
  }
}
