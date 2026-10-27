import { Knex } from 'knex';
import { sumBy } from 'lodash';
import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Contact } from './models/Contact';
import {
  OPENING_BALANCE_ERRORS,
  isOpeningBalanceEntry,
} from './ContactOpeningBalance.constants';

interface IPaymentEntryLike {
  entryType?: string | null;
  paymentAmount: number | string;
}

/**
 * A payment's opening balance side: who it belongs to and its entries.
 */
export interface IOpeningBalancePaymentSide {
  contactId: number;
  entries?: IPaymentEntryLike[] | null;
}

const round3 = (value: number) => Math.round((value || 0) * 1000) / 1000;

/**
 * Sums the amount the given entries apply to the opening balance.
 * @param {IPaymentEntryLike[]} entries
 * @returns {number}
 */
export const getOpeningBalancePaidAmount = (
  entries: IPaymentEntryLike[] | null | undefined,
): number =>
  round3(
    sumBy((entries || []).filter(isOpeningBalanceEntry), (entry) =>
      Number(entry.paymentAmount || 0),
    ),
  );

/**
 * Validates and keeps `contacts.opening_balance_payment_amount` in sync with
 * the payment entries that pay the contact opening balance. Shared by the
 * payments received (customers) and payments made (vendors).
 */
@Injectable()
export class ContactOpeningBalancePayment {
  constructor(
    @Inject(Contact.name)
    private readonly contactModel: TenantModelProxy<typeof Contact>,
  ) {}

  /**
   * Validates the opening balance entry of a payment being saved:
   * - at most one opening balance entry,
   * - the contact has an opening balance,
   * - the amount is not negative and not more than the opening balance due
   *   (plus what this payment already paid, on edit).
   * Locks the contact row (FOR UPDATE) so two payments saved at the same
   * moment can't both pay the whole opening balance.
   * @param {IOpeningBalancePaymentSide} payment - The payment being saved.
   * @param {IOpeningBalancePaymentSide | null} oldPayment - The stored payment on edit.
   * @param {Knex.Transaction} trx
   */
  public async validateOpeningBalanceEntries(
    payment: IOpeningBalancePaymentSide,
    oldPayment: IOpeningBalancePaymentSide | null,
    trx: Knex.Transaction,
  ): Promise<void> {
    const entries = (payment.entries || []).filter(isOpeningBalanceEntry);

    if (entries.length === 0) return;

    if (entries.length > 1) {
      throw new ServiceError(
        OPENING_BALANCE_ERRORS.OPENING_BALANCE_ENTRY_DUPLICATE,
      );
    }
    const amount = round3(Number(entries[0].paymentAmount || 0));

    if (amount < 0) {
      throw new ServiceError(
        OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
        'The opening balance payment amount can not be negative.',
      );
    }
    const contact = await this.contactModel()
      .query(trx)
      .findById(payment.contactId)
      .forUpdate();

    if (!contact || !(Number(contact.openingBalance) > 0)) {
      throw new ServiceError(OPENING_BALANCE_ERRORS.OPENING_BALANCE_NOT_FOUND);
    }
    // What this payment already paid of the same contact's opening balance.
    const oldAmount =
      oldPayment && oldPayment.contactId === payment.contactId
        ? getOpeningBalancePaidAmount(oldPayment.entries)
        : 0;
    const dueAmount = round3(
      Number(contact.openingBalance) -
        Number(contact.openingBalancePaymentAmount || 0) +
        oldAmount,
    );
    if (amount > dueAmount) {
      throw new ServiceError(
        OPENING_BALANCE_ERRORS.OPENING_BALANCE_PAYMENT_EXCEEDS_DUE,
        null,
        { dueAmount },
      );
    }
  }

  /**
   * Saves the change of the paid opening balance once a payment is created,
   * edited or deleted. Pass `null` as the old side on create and as the new
   * side on delete. A changed contact moves the paid amount from the old
   * contact to the new one.
   * @param {IOpeningBalancePaymentSide | null} newPayment
   * @param {IOpeningBalancePaymentSide | null} oldPayment
   * @param {Knex.Transaction} trx
   */
  public async syncPaidAmount(
    newPayment: IOpeningBalancePaymentSide | null,
    oldPayment: IOpeningBalancePaymentSide | null,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const changes = new Map<number, number>();
    const add = (contactId: number | undefined, amount: number) => {
      if (!contactId || !amount) return;
      changes.set(contactId, round3((changes.get(contactId) || 0) + amount));
    };
    add(
      newPayment?.contactId,
      getOpeningBalancePaidAmount(newPayment?.entries),
    );
    add(
      oldPayment?.contactId,
      -getOpeningBalancePaidAmount(oldPayment?.entries),
    );

    for (const [contactId, amount] of changes) {
      if (!amount) continue;

      await this.contactModel()
        .query(trx)
        .findById(contactId)
        .increment('opening_balance_payment_amount', amount);
    }
  }
}
