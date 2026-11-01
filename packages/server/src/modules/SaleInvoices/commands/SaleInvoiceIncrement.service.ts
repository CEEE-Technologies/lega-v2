import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { AutoIncrementOrdersService } from '../../AutoIncrementOrders/AutoIncrementOrders.service';

@Injectable()
export class SaleInvoiceIncrement {
  constructor(
    private readonly autoIncrementOrdersService: AutoIncrementOrdersService,
  ) {}

  /**
   * Retrieves the next unique invoice number.
   * @param {number} tenantId - Tenant id.
   * @return {Promise<string>}
   */
  public getNextInvoiceNumber(): Promise<string> {
    return this.autoIncrementOrdersService.getNextTransactionNumber(
      'sales_invoices',
    );
  }

  /**
   * Picks the invoice number inside the invoice save (see
   * `AutoIncrementOrdersService.reserveNextNumber`).
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The invoice save transaction.
   */
  public reserveInvoiceNumber(
    givenNumber: string | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    return this.autoIncrementOrdersService.reserveNextNumber(
      'sales_invoices',
      givenNumber,
      trx,
    );
  }
}
