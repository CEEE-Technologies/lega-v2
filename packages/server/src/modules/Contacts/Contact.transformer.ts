import { subtractMoney } from '@bigcapital/utils';
import { isNull } from 'lodash';
import { Transformer } from '../Transformer/Transformer';
import { Contact } from './models/Contact';

export class ContactTransfromer extends Transformer {
  /**
   * Retrieve formatted expense amount.
   * @param {IExpense} expense
   * @returns {string}
   */
  protected formattedBalance = (contact: Contact): string => {
    return this.formatNumber(contact.balance, {
      currencyCode: contact.currencyCode,
    });
  };

  /**
   * Retrieve formatted expense landed cost amount.
   * @param {IExpense} expense
   * @returns {string}
   */
  protected formattedOpeningBalance = (contact: Contact): string => {
    return !isNull(contact.openingBalance)
      ? this.formatNumber(contact.openingBalance, {
          currencyCode: contact.currencyCode,
        })
      : '';
  };

  /**
   * Retrieves the unpaid part of the opening balance.
   * @param {Contact} contact
   * @returns {number}
   */
  protected openingBalanceDueAmount = (contact: Contact): number => {
    return Math.max(
      subtractMoney(
        contact.openingBalance,
        contact.openingBalancePaymentAmount,
      ),
      0,
    );
  };

  /**
   * Retrieves the formatted paid part of the opening balance.
   * @param {Contact} contact
   * @returns {string}
   */
  protected formattedOpeningBalancePaymentAmount = (
    contact: Contact,
  ): string => {
    return this.formatNumber(contact.openingBalancePaymentAmount || 0, {
      currencyCode: contact.currencyCode,
    });
  };

  /**
   * Retrieves the formatted unpaid part of the opening balance.
   * @param {Contact} contact
   * @returns {string}
   */
  protected formattedOpeningBalanceDueAmount = (contact: Contact): string => {
    return this.formatNumber(this.openingBalanceDueAmount(contact), {
      currencyCode: contact.currencyCode,
    });
  };

  /**
   * Retriecve fromatted date.
   * @param {IExpense} expense
   * @returns {string}
   */
  protected formattedOpeningBalanceAt = (contact: Contact): string => {
    return !isNull(contact.openingBalanceAt)
      ? this.formatDate(contact.openingBalanceAt)
      : '';
  };
}
