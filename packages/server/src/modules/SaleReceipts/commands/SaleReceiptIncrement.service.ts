import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';

@Injectable()
export class SaleReceiptIncrement {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique receipt number.
   * @param  {number} tenantId - Tenant id.
   * @return {string}
   */
  public getNextReceiptNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'sales_receipts',
    );
  }

  /**
   * Picks the receipt number inside the receipt save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The receipt save transaction.
   */
  public reserveReceiptNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'sales_receipts',
      givenNumber,
      trx,
    );
  }
}
