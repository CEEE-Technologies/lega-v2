import { AccountNormal } from '@/interfaces/Account';
import { Transformer } from '@/modules/Transformer/Transformer';
import { bankAccountNet } from '../_utils';

export class GetMatchedTransactionManualJournalsTransformer extends Transformer {
  /**
   * Include these attributes to sale credit note object.
   * @returns {Array}
   */
  public includeAttributes = (): string[] => {
    return [
      'referenceNo',
      'amount',
      'amountFormatted',
      'transactionNo',
      'date',
      'dateFormatted',
      'transactionId',
      'transactionNo',
      'transactionType',
      'transsactionTypeFormatted',
      'transactionNormal',
      'referenceType',
      'referenceId',
    ];
  };

  /**
   * Exclude all attributes.
   * @returns {Array<string>}
   */
  public excludeAttributes = (): string[] => {
    return ['*'];
  };

  /**
   * Retrieves the manual journal reference no.
   * @param manualJournal
   * @returns {string}
   */
  protected referenceNo(manualJournal) {
    return manualJournal.referenceNo;
  }

  /**
   * What the journal moves on the bank account (its loaded lines), in the
   * account's currency (`accountCurrencyCode` option).
   */
  protected total(manualJournal) {
    return bankAccountNet(manualJournal, this.options?.accountCurrencyCode);
  }

  /**
   * Retrieves the manual journal amount.
   * @param manualJournal
   * @returns {number}
   */
  protected amount(manualJournal) {
    return Math.abs(this.total(manualJournal));
  }

  /**
   * Retrieves the manual journal formatted amount.
   * @param manualJournal
   * @returns {string}
   */
  protected amountFormatted(manualJournal) {
    return this.formatNumber(this.amount(manualJournal), {
      currencyCode:
        this.options?.accountCurrencyCode ?? manualJournal.currencyCode,
      money: true,
    });
  }

  /**
   * Retreives the manual journal date.
   * @param manualJournal
   * @returns {Date}
   */
  protected date(manualJournal) {
    return manualJournal.date;
  }

  /**
   * Retrieves the manual journal formatted date.
   * @param manualJournal
   * @returns {string}
   */
  protected dateFormatted(manualJournal) {
    return this.formatDate(manualJournal.date);
  }

  /**
   * Retrieve the manual journal transaction id.
   * @returns {number}
   */
  protected transactionId(manualJournal) {
    return manualJournal.id;
  }

  /**
   * Retrieve the manual journal transaction number.
   * @param manualJournal
   */
  protected transactionNo(manualJournal) {
    return manualJournal.journalNumber;
  }

  /**
   * Retrieve the manual journal transaction type.
   * @returns {string}
   */
  protected transactionType() {
    return 'ManualJournal';
  }

  /**
   * Retrieves the manual journal formatted transaction type.
   * @returns {string}
   */
  protected transsactionTypeFormatted() {
    return this.context.i18n.t('transaction_type.manual_journal');
  }

  /**
   * Retrieve the manual journal transaction normal (credit or debit).
   * @returns {string}
   */
  protected transactionNormal(transaction) {
    const amount = this.total(transaction);

    return amount >= 0 ? AccountNormal.DEBIT : AccountNormal.CREDIT;
  }

  /**
   * Retrieve the manual journal reference type.
   * @returns {string}
   */
  protected referenceType() {
    return 'ManualJournal';
  }

  /**
   * Retrieves the manual journal reference id.
   * @param transaction
   * @returns {number}
   */
  protected referenceId(transaction) {
    return transaction.id;
  }
}
