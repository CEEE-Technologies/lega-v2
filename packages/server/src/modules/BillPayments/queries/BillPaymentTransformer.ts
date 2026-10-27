import { subtractMoney, sumMoneyBy } from '@bigcapital/utils';
import { BillPaymentEntryTransformer } from './BillPaymentEntry.transformer';
import { Transformer } from '@/modules/Transformer/Transformer';
import { BillPayment } from '../models/BillPayment';
import { AttachmentTransformer } from '@/modules/Attachments/Attachment.transformer';

export class BillPaymentTransformer extends Transformer {
  /**
   * Include these attributes to sale invoice object.
   * @returns {Array}
   */
  public includeAttributes = (): string[] => {
    return [
      'formattedPaymentDate',
      'formattedCreatedAt',
      'formattedAmount',
      'formattedTotal',
      'formattedSubtotal',
      'appliedAmount',
      'appliedAmountFormatted',
      'unappliedAmount',
      'unappliedAmountFormatted',
      'entries',
      'attachments',
    ];
  };

  /**
   * Retrieve formatted invoice date.
   * @param {IBill} invoice
   * @returns {String}
   */
  protected formattedPaymentDate = (billPayment: BillPayment): string => {
    return this.formatDate(billPayment.paymentDate);
  };

  /**
   * Retrieve formatted created at date.
   * @param {IBillPayment} billPayment
   * @returns {string}
   */
  protected formattedCreatedAt = (billPayment: BillPayment): string => {
    return this.formatDate(billPayment.createdAt);
  };

  /**
   * Retrieve formatted bill amount.
   * @param {IBill} invoice
   * @returns {string}
   */
  protected formattedAmount = (billPayment: BillPayment): string => {
    return this.formatNumber(billPayment.amount, {
      currencyCode: billPayment.currencyCode,
    });
  };

  /**
   * Retrieves the formatted total.
   * @param {IBillPayment} billPayment
   * @returns {string}
   */
  protected formattedTotal = (billPayment: BillPayment): string => {
    return this.formatNumber(billPayment.amount, {
      currencyCode: billPayment.currencyCode,
      money: true,
    });
  };

  /**
   * Retrieves the formatted subtotal.
   * @param {IBillPayment} billPayment
   * @returns {string}
   */
  protected formattedSubtotal = (billPayment: BillPayment): string => {
    return this.formatNumber(billPayment.amount, {
      currencyCode: billPayment.currencyCode,
    });
  };

  /**
   * Retrieves the amount applied to documents and the opening balance, or
   * null when the entries are not loaded.
   * @param {BillPayment} billPayment
   * @returns {number | null}
   */
  protected appliedAmount = (billPayment: BillPayment): number | null => {
    if (!billPayment.entries) return null;

    return sumMoneyBy(billPayment.entries, 'paymentAmount');
  };

  /**
   * Retrieves the amount not applied yet (the payment credit), or null when
   * the entries are not loaded.
   * @param {BillPayment} billPayment
   * @returns {number | null}
   */
  protected unappliedAmount = (billPayment: BillPayment): number | null => {
    const applied = this.appliedAmount(billPayment);
    if (applied === null) return null;

    return Math.max(subtractMoney(billPayment.amount, applied), 0);
  };

  /**
   * Retrieves the formatted applied amount.
   * @param {BillPayment} billPayment
   * @returns {string | null}
   */
  protected appliedAmountFormatted = (
    billPayment: BillPayment,
  ): string | null => {
    const applied = this.appliedAmount(billPayment);
    if (applied === null) return null;

    return this.formatNumber(applied, {
      currencyCode: billPayment.currencyCode,
    });
  };

  /**
   * Retrieves the formatted unapplied amount.
   * @param {BillPayment} billPayment
   * @returns {string | null}
   */
  protected unappliedAmountFormatted = (
    billPayment: BillPayment,
  ): string | null => {
    const unapplied = this.unappliedAmount(billPayment);
    if (unapplied === null) return null;

    return this.formatNumber(unapplied, {
      currencyCode: billPayment.currencyCode,
    });
  };

  /**
   * Retreives the bill payment entries.
   */
  protected entries = (billPayment: BillPayment) => {
    return this.item(billPayment.entries, new BillPaymentEntryTransformer());
  };

  /**
   * Retrieves the bill attachments.
   * @param {ISaleInvoice} invoice
   * @returns
   */
  protected attachments = (billPayment: BillPayment) => {
    return this.item(billPayment.attachments, new AttachmentTransformer());
  };
}
