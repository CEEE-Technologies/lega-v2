import { Knex } from 'knex';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class WarehouseTransferAutoIncrement {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique invoice number.
   * @return {Promise<string>}
   */
  public getNextTransferNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'warehouse_transfers',
    );
  }

  /**
   * Picks the warehouse transfer number inside the warehouse transfer save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The warehouse transfer save transaction.
   */
  public reserveTransferNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'warehouse_transfers',
      givenNumber,
      trx,
    );
  }
}
