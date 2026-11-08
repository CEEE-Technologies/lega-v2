import { Inject, Injectable } from '@nestjs/common';
import { GetRecognizedTransactionTransformer } from './GetRecognizedTransactionTransformer';
import { TransformerInjectable } from '@/modules/Transformer/TransformerInjectable.service';
import { UncategorizedBankTransaction } from '../../BankingTransactions/models/UncategorizedBankTransaction';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class GetRecognizedTransactionService {
  constructor(
    private readonly transformer: TransformerInjectable,

    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,
  ) {}

  /**
   * Retrieves the recognized transaction of the given uncategorized transaction.
   * @param {number} tenantId
   * @param {number} uncategorizedTransactionId
   */
  public async getRecognizedTransaction(uncategorizedTransactionId: number) {
    const uncategorizedTransaction =
      await this.uncategorizedBankTransactionModel()
        .query()
        .findById(uncategorizedTransactionId)
        // Only a bank line a rule recognized has a recognized transaction;
        // any other line is not found (it used to crash the transformer).
        .whereNotNull('recognizedTransactionId')
        .withGraphFetched('matchedBankTransactions')
        .withGraphFetched('recognizedTransaction.assignAccount')
        .withGraphFetched('recognizedTransaction.bankRule')
        .withGraphFetched('account')
        .throwIfNotFound();

    return this.transformer.transform(
      uncategorizedTransaction,
      new GetRecognizedTransactionTransformer(),
    );
  }
}
