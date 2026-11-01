import { Knex } from 'knex';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CreditNoteAutoIncrementService {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieve the next unique credit number.
   * @return {string}
   */
  public getNextCreditNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'credit_note',
    );
  }

  /**
   * Picks the credit note number inside the credit note save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The credit note save transaction.
   */
  public reserveCreditNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'credit_note',
      givenNumber,
      trx,
    );
  }
}
