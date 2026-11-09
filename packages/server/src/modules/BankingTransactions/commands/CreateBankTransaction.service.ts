import { Inject, Injectable } from '@nestjs/common';
import { pick } from 'lodash';
import { Knex } from 'knex';
import * as composeAsync from 'async/compose';
import { CASHFLOW_TRANSACTION_TYPE } from '../constants';
import { transformCashflowTransactionType } from '../utils';
import { CommandBankTransactionValidator } from './CommandCasflowValidator.service';
import { BankTransactionAutoIncrement } from './BankTransactionAutoIncrement.service';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BranchTransactionDTOTransformer } from '@/modules/Branches/integrations/BranchTransactionDTOTransform';
import { events } from '@/common/events/events';
import { Account } from '@/modules/Accounts/models/Account.model';
import { BankTransaction } from '../models/BankTransaction';
import {
  ICommandCashflowCreatedPayload,
  ICommandCashflowCreatingPayload,
} from '../types/BankingTransactions.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CreateBankTransactionDto } from '../dtos/CreateBankTransaction.dto';
import { formatDateFields } from '@/utils/format-date-fields';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../constants';

@Injectable()
export class CreateBankTransactionService {
  constructor(
    private validator: CommandBankTransactionValidator,
    private uow: UnitOfWork,
    private eventPublisher: EventEmitter2,
    private autoIncrement: BankTransactionAutoIncrement,
    private branchDTOTransform: BranchTransactionDTOTransformer,

    @Inject(BankTransaction.name)
    private bankTransactionModel: TenantModelProxy<typeof BankTransaction>,

    @Inject(Account.name)
    private accountModel: TenantModelProxy<typeof Account>,

    private tenancyContext: TenancyContext,
  ) {}

  /**
   * The rate of a transaction on the account: 1 on a base-currency
   * account; on a foreign-currency one the given rate, which is required
   * (the amount is in the account's currency and the books get amount ×
   * rate, so a missing rate used to post at 1).
   * @param {number | undefined} exchangeRate
   * @param {Account} cashflowAccount
   */
  private getExchangeRate = async (
    exchangeRate: number | undefined,
    cashflowAccount: Account,
  ): Promise<number> => {
    const metadata = await this.tenancyContext.getTenantMetadata();
    const baseCurrency = metadata?.baseCurrency;

    if (!baseCurrency || cashflowAccount.currencyCode === baseCurrency) {
      return 1;
    }
    if (!(Number(exchangeRate) > 0)) {
      throw new ServiceError(
        ERRORS.EXCHANGE_RATE_REQUIRED,
        `The exchange rate is required for a ${cashflowAccount.currencyCode} account.`,
      );
    }
    return Number(exchangeRate);
  };

  /**
   * Authorize the cashflow creating transaction.
   * @param {ICashflowNewCommandDTO} newCashflowTransactionDTO
   */
  public authorize = async (
    newCashflowTransactionDTO: CreateBankTransactionDto,
    creditAccount: Account,
  ) => {
    const transactionType = transformCashflowTransactionType(
      newCashflowTransactionDTO.transactionType,
    );
    // Validates the cashflow transaction type.
    this.validator.validateCashflowTransactionType(transactionType);

    // Retrieve accounts of the cashflow lines object.
    this.validator.validateCreditAccountWithCashflowType(
      creditAccount,
      transactionType as CASHFLOW_TRANSACTION_TYPE,
    );
  };

  /**
   * Transformes owner contribution DTO to cashflow transaction.
   * @param {CreateBankTransactionDto} newCashflowTransactionDTO - New transaction DTO.
   * @returns {ICashflowTransactionInput} - Cashflow transaction object.
   */
  private transformCashflowTransactionDTO = async (
    newCashflowTransactionDTO: CreateBankTransactionDto,
    cashflowAccount: Account,
    userId: number,
  ): Promise<BankTransaction> => {
    const amount = newCashflowTransactionDTO.amount;

    const fromDTO = pick(newCashflowTransactionDTO, [
      'date',
      'referenceNo',
      'description',
      'transactionType',
      'exchangeRate',
      'cashflowAccountId',
      'creditAccountId',
      'branchId',
      'plaidTransactionId',
      'uncategorizedTransactionId',
    ]);
    // Retreive the next invoice number.
    const autoNextNumber = await this.autoIncrement.getNextTransactionNumber();

    // Retrieve the transaction number.
    const transactionNumber =
      newCashflowTransactionDTO.transactionNumber || autoNextNumber;

    const initialDTO = {
      amount,
      ...formatDateFields(fromDTO, ['date']),
      transactionNumber,
      currencyCode: cashflowAccount.currencyCode,
      exchangeRate: await this.getExchangeRate(
        fromDTO?.exchangeRate,
        cashflowAccount,
      ),
      transactionType: transformCashflowTransactionType(
        fromDTO.transactionType,
      ),
      userId,
      ...(newCashflowTransactionDTO.publish
        ? {
            publishedAt: new Date(),
          }
        : {}),
    };
    return composeAsync(this.branchDTOTransform.transformDTO<BankTransaction>)(
      initialDTO,
    ) as BankTransaction;
  };

  /**
   * Owner contribution money in.
   * @param {ICashflowOwnerContributionDTO} ownerContributionDTO
   * @param {number} userId - User id.
   * @returns {Promise<ICashflowTransaction>}
   */
  public newCashflowTransaction = async (
    newTransactionDTO: CreateBankTransactionDto,
    userId?: number,
    trx?: Knex.Transaction,
  ): Promise<BankTransaction> => {
    // Retrieves the cashflow account or throw not found error.
    const cashflowAccount = await this.accountModel()
      .query()
      .findById(newTransactionDTO.cashflowAccountId)
      .throwIfNotFound();

    // Retrieves the credit account or throw not found error.
    const creditAccount = await this.accountModel()
      .query()
      .findById(newTransactionDTO.creditAccountId)
      .throwIfNotFound();

    // Authorize before creating cashflow transaction.
    await this.authorize(newTransactionDTO, creditAccount);

    // Transformes owner contribution DTO to cashflow transaction.
    const cashflowTransactionObj = await this.transformCashflowTransactionDTO(
      newTransactionDTO,
      cashflowAccount,
      userId,
    );
    // Creates a new cashflow transaction under UOW envirement.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Picks the number inside the save, one save at a time, so two
      // transactions saved at the same moment never share a number.
      cashflowTransactionObj.transactionNumber =
        (await this.autoIncrement.reserveTransactionNumber(
          newTransactionDTO.transactionNumber,
          trx,
        )) || cashflowTransactionObj.transactionNumber;

      // Triggers `onCashflowTransactionCreate` event.
      await this.eventPublisher.emitAsync(
        events.cashflow.onTransactionCreating,
        {
          trx,
          newTransactionDTO,
        } as ICommandCashflowCreatingPayload,
      );
      // Inserts cashflow owner contribution transaction.
      const cashflowTransaction = await this.bankTransactionModel()
        .query(trx)
        .upsertGraph(cashflowTransactionObj);

      // Triggers `onCashflowTransactionCreated` event.
      await this.eventPublisher.emitAsync(
        events.cashflow.onTransactionCreated,
        {
          newTransactionDTO,
          cashflowTransaction,
          trx,
        } as ICommandCashflowCreatedPayload,
      );
      return cashflowTransaction;
    }, trx);
  };
}
