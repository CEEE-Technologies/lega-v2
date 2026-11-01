import { castArray } from 'lodash';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import {
  ICashflowTransactionCategorizedPayload,
  ICashflowTransactionUncategorizingPayload,
} from '../types/BankingCategorize.types';
import {
  transformCategorizeTransToCashflow,
  validateUncategorizedTransactionsNotExcluded,
} from '../../BankingTransactions/utils';
import { CommandBankTransactionValidator } from '../../BankingTransactions/commands/CommandCasflowValidator.service';
import { CreateBankTransactionService } from '../../BankingTransactions/commands/CreateBankTransaction.service';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { UncategorizedBankTransaction } from '@/modules/BankingTransactions/models/UncategorizedBankTransaction';
import { events } from '@/common/events/events';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CategorizeBankTransactionDto } from '../dtos/CategorizeBankTransaction.dto';
import { validateUncategorizedTransactionsNotMatched } from '@/modules/BankingMatching/_utils';

@Injectable()
export class CategorizeBankTransaction {
  constructor(
    private readonly eventPublisher: EventEmitter2,
    private readonly uow: UnitOfWork,
    private readonly commandValidators: CommandBankTransactionValidator,
    private readonly createBankTransaction: CreateBankTransactionService,

    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,
  ) {}

  /**
   * Categorize the given cashflow transaction.
   * @param {ICategorizeCashflowTransactioDTO} categorizeDTO - Categorize DTO.
   */
  public async categorize(
    uncategorizedTransactionId: number | Array<number>,
    categorizeDTO: CategorizeBankTransactionDto,
  ) {
    const uncategorizedTransactionIds = castArray(uncategorizedTransactionId);

    // The check, the posting and the "categorized" mark run in one save, with
    // the bank lines locked, so a double click or a second tab waits and is
    // then refused, and a failure leaves nothing posted.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Validates the categorize operation against the locked bank lines.
      const oldUncategorizedTransactions = await this.validate(
        uncategorizedTransactionIds,
        categorizeDTO,
        trx,
      );
      // Triggers `onTransactionCategorizing` event.
      await this.eventPublisher.emitAsync(
        events.cashflow.onTransactionCategorizing,
        {
          oldUncategorizedTransactions,
          trx,
        } as ICashflowTransactionUncategorizingPayload,
      );
      // Transformes the categorize DTO to the cashflow transaction.
      const cashflowTransactionDTO = transformCategorizeTransToCashflow(
        oldUncategorizedTransactions,
        categorizeDTO,
      );
      // Creates a new cashflow transaction.
      const cashflowTransaction =
        await this.createBankTransaction.newCashflowTransaction(
          cashflowTransactionDTO,
          undefined,
          trx,
        );

      // Updates the uncategorized transaction as categorized.
      await this.uncategorizedBankTransactionModel()
        .query(trx)
        .whereIn('id', uncategorizedTransactionIds)
        .patch({
          categorized: true,
          categorizeRefType: 'CashflowTransaction',
          categorizeRefId: cashflowTransaction.id,
        });
      // Fetch the new updated uncategorized transactions.
      const uncategorizedTransactions =
        await this.uncategorizedBankTransactionModel()
          .query(trx)
          .whereIn('id', uncategorizedTransactionIds);
      // Triggers `onCashflowTransactionCategorized` event.
      await this.eventPublisher.emitAsync(
        events.cashflow.onTransactionCategorized,
        {
          cashflowTransaction,
          uncategorizedTransactions,
          oldUncategorizedTransactions,
          categorizeDTO,
          trx,
        } as ICashflowTransactionCategorizedPayload,
      );
    });
  }

  /**
   * Validates the categorize operation against the locked bank lines: they
   * exist, aren't excluded, matched or already categorized, and go in the
   * direction of the transaction type.
   * @param {number[]} uncategorizedTransactionIds - Bank line ids.
   * @param {CategorizeBankTransactionDto} categorizeDTO - Categorize DTO.
   * @param {Knex.Transaction} trx - Locks the bank lines (FOR UPDATE).
   * @returns {Promise<UncategorizedBankTransaction[]>} The locked lines.
   */
  async validate(
    uncategorizedTransactionIds: Array<number>,
    categorizeDTO: CategorizeBankTransactionDto,
    trx: Knex.Transaction,
  ): Promise<UncategorizedBankTransaction[]> {
    // Retrieves the bank lines with a row lock or throw an error.
    const oldUncategorizedTransactions =
      await this.uncategorizedBankTransactionModel()
        .query(trx)
        .whereIn('id', uncategorizedTransactionIds)
        .orderBy('id')
        .forUpdate()
        .withGraphFetched('matchedBankTransactions')
        .throwIfNotFound();

    // Validate cannot categorize excluded transaction.
    validateUncategorizedTransactionsNotExcluded(oldUncategorizedTransactions);

    // A matched line is already in the books through the matched transaction.
    validateUncategorizedTransactionsNotMatched(oldUncategorizedTransactions);

    // Validates the transaction shouldn't be categorized before.
    this.commandValidators.validateTransactionsShouldNotCategorized(
      oldUncategorizedTransactions,
    );
    // Validate the uncateogirzed transaction if it's deposit the transaction direction
    // should `IN` and the same thing if it's withdrawal the direction should be OUT.
    this.commandValidators.validateUncategorizeTransactionType(
      oldUncategorizedTransactions,
      categorizeDTO.transactionType,
    );
    return oldUncategorizedTransactions;
  }
}
