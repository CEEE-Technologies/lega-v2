import { subtractMoney, sumMoneyBy } from '@bigcapital/utils';
import { Transformer } from '../../Transformer/Transformer';
import { PaymentReceived } from '../models/PaymentReceived';
import { PaymentReceivedEntry } from '../models/PaymentReceivedEntry';
import { PaymentReceivedEntryTransfromer } from './PaymentReceivedEntryTransformer';
import { AttachmentTransformer } from '@/modules/Attachments/Attachment.transformer';

export class PaymentReceiveTransfromer extends Transformer {
  /**
   * Include these attributes to payment receive object.
   * @returns {Array}
   */
  public includeAttributes = (): string[] => {
    return [
      'subtotalFormatted',
      'formatttedTotal',
      'formattedPaymentDate',
      'formattedCreatedAt',
      'formattedAmount',
      'formattedExchangeRate',
      'appliedAmount',
      'appliedAmountFormatted',
      'unappliedAmount',
      'unappliedAmountFormatted',
      'entries',
      'attachments',
    ];
  };

  /**
   * Retrieve formatted payment receive date.
   * @param {PaymentReceived} invoice
   * @returns {String}
   */
  protected formattedPaymentDate = (payment: PaymentReceived): string => {
    return this.formatDate(payment.paymentDate);
  };

  /**
   * Retrieves the formatted created at date.
   * @param {PaymentReceived} payment
   * @returns {string}
   */
  protected formattedCreatedAt = (payment: PaymentReceived): string => {
    return this.formatDate(payment.createdAt);
  };

  /**
   * Retrieve the formatted payment subtotal.
   * @param {PaymentReceived} payment
   * @returns {string}
   */
  protected subtotalFormatted = (payment: PaymentReceived): string => {
    return this.formatNumber(payment.amount, {
      currencyCode: payment.currencyCode,
    });
  };

  /**
   * Retrieves the formatted total.
   * @param {PaymentReceived} payment
   * @returns {string}
   */
  protected formatttedTotal = (payment: PaymentReceived): string => {
    return this.formatNumber(payment.amount, {
      currencyCode: payment.currencyCode,
      money: true,
    });
  };

  /**
   * Retrieve formatted payment amount.
   * @param {PaymentReceived} invoice
   * @returns {string}
   */
  protected formattedAmount = (payment: PaymentReceived): string => {
    return this.formatNumber(payment.amount, {
      currencyCode: payment.currencyCode,
    });
  };

  /**
   * Retrieve the formatted exchange rate.
   * @param   {PaymentReceived} payment
   * @returns {string}
   */
  protected formattedExchangeRate = (payment: PaymentReceived): string => {
    return this.formatNumber(payment.exchangeRate);
  };

  /**
   * Retrieves the amount applied to documents and the opening balance, or
   * null when the entries are not loaded.
   * @param {PaymentReceived} payment
   * @returns {number | null}
   */
  protected appliedAmount = (payment: PaymentReceived): number | null => {
    if (!payment.entries) return null;

    return sumMoneyBy(payment.entries, 'paymentAmount');
  };

  /**
   * Retrieves the amount not applied yet (the payment credit), or null when
   * the entries are not loaded.
   * @param {PaymentReceived} payment
   * @returns {number | null}
   */
  protected unappliedAmount = (payment: PaymentReceived): number | null => {
    const applied = this.appliedAmount(payment);
    if (applied === null) return null;

    return Math.max(subtractMoney(payment.amount, applied), 0);
  };

  /**
   * Retrieves the formatted applied amount.
   * @param {PaymentReceived} payment
   * @returns {string | null}
   */
  protected appliedAmountFormatted = (
    payment: PaymentReceived,
  ): string | null => {
    const applied = this.appliedAmount(payment);
    if (applied === null) return null;

    return this.formatNumber(applied, { currencyCode: payment.currencyCode });
  };

  /**
   * Retrieves the formatted unapplied amount.
   * @param {PaymentReceived} payment
   * @returns {string | null}
   */
  protected unappliedAmountFormatted = (
    payment: PaymentReceived,
  ): string | null => {
    const unapplied = this.unappliedAmount(payment);
    if (unapplied === null) return null;

    return this.formatNumber(unapplied, { currencyCode: payment.currencyCode });
  };

  /**
   * Retrieves the payment entries.
   * @param {PaymentReceived} payment
   * @returns {IPaymentReceivedEntry[]}
   */
  protected entries = (payment: PaymentReceived): PaymentReceivedEntry[] => {
    return this.item(payment.entries, new PaymentReceivedEntryTransfromer());
  };

  /**
   * Retrieves the payment received attachments.
   * @param {PaymentReceived} payment
   * @returns
   */
  protected attachments = (payment: PaymentReceived) => {
    return this.item(payment.attachments, new AttachmentTransformer());
  };
}
