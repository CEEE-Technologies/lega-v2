import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { AutoIncrementOrdersService } from '@/modules/AutoIncrementOrders/AutoIncrementOrders.service';

@Injectable()
export class AutoIncrementManualJournal {
  /**
   *
   * @param autoIncrementOrdersService
   */
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   *
   * @returns {boolean}
   */
  public autoIncrementEnabled = () => {
    return this.autoIncrementOrdersService.autoIncrementEnabled(
      'manual_journals',
    );
  };

  /**
   * Retrieve the next journal number.
   * @returns {Promise<string>}
   */
  public getNextJournalNumber = (): Promise<string> => {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'manual_journals',
    );
  };

  /**
   * Picks the manual journal number inside the manual journal save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The manual journal save transaction.
   */
  public reserveJournalNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'manual_journals',
      givenNumber,
      trx,
    );
  }
}
