import { Knex } from 'knex';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class VendorCreditAutoIncrementService {
  /**
   * @param {AutoIncrementOrdersService} autoIncrementOrdersService - Auto increment orders service.
   */
  constructor(private autoIncrementOrdersService: AutoIncrementOrdersService) {}

  /**
   * Retrieve the next unique credit number.
   * @param  {number} tenantId - Tenant id.
   * @return {string}
   */
  public getNextCreditNumber = (): Promise<string> => {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'vendor_credit',
    );
  };

  /**
   * Picks the vendor credit number inside the vendor credit save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The vendor credit save transaction.
   */
  public reserveCreditNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'vendor_credit',
      givenNumber,
      trx,
    );
  }
}
