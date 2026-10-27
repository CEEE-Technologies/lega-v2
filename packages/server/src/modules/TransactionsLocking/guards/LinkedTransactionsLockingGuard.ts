import * as moment from 'moment';
import { MomentInput } from 'moment';
import { Injectable } from '@nestjs/common';
import { TransactionsLockingGroup } from '../types/TransactionsLocking.types';
import { TransactionsLockingRepository } from '../TransactionsLockingRepository';
import { TransactionsLockingGuard } from './TransactionsLockingGuard';
import { ServiceError } from '@/modules/Items/ServiceError';

export const LINKED_TRANSACTIONS_DATE_LOCKED =
  'LINKED_TRANSACTIONS_DATE_LOCKED';

/**
 * A transaction linked to an edited document, whose entries the edit
 * rewrites (a payment of an invoice/bill, a refund of a credit).
 */
export interface ILinkedTransaction {
  label: string;
  date: MomentInput;
}

/**
 * Blocks editing a document when it would rewrite the entries of a linked
 * transaction (payment or refund) dated inside a locked period, so a locked
 * period never changes through a later edit.
 */
@Injectable()
export class LinkedTransactionsLockingGuard {
  constructor(
    private readonly transactionsLockingGuard: TransactionsLockingGuard,
    private readonly transactionsLockingRepo: TransactionsLockingRepository,
  ) {}

  /**
   * Validates none of the linked transactions is in a locked period.
   * @param {ILinkedTransaction[]} transactions - The linked transactions.
   * @param {TransactionsLockingGroup} lockingGroup - The linked transactions group.
   * @param {string} documentLabel - What is edited, e.g. "this bill".
   * @throws {ServiceError(LINKED_TRANSACTIONS_DATE_LOCKED)}
   */
  public async validateLinkedTransactionsNotLocked(
    transactions: ILinkedTransaction[],
    lockingGroup: TransactionsLockingGroup,
    documentLabel: string,
  ): Promise<void> {
    if (transactions.length === 0) return;

    const lockingType =
      await this.transactionsLockingRepo.getTransactionsLockingType();
    const group =
      lockingType === TransactionsLockingGroup.All
        ? TransactionsLockingGroup.All
        : lockingGroup;

    const locked: ILinkedTransaction[] = [];

    for (const transaction of transactions) {
      if (
        await this.transactionsLockingGuard.isTransactionsLocking(
          transaction.date,
          group,
        )
      ) {
        locked.push(transaction);
      }
    }
    if (locked.length === 0) return;

    const { lockToDate } =
      await this.transactionsLockingRepo.getTransactionsLocking(group);
    const names = locked
      .map(
        ({ label, date }) => `${label} (${moment(date).format('D MMM YYYY')})`,
      )
      .join(', ');
    const verb = locked.length > 1 ? 'are' : 'is';

    throw new ServiceError(
      LINKED_TRANSACTIONS_DATE_LOCKED,
      `${names} ${verb} linked to ${documentLabel} and ${verb} in a locked period ` +
        `(locked up to ${moment(lockToDate).format('D MMM YYYY')}). ` +
        `Editing would change that period: unlock it first, or leave ${documentLabel} unchanged.`,
      {
        transactions: locked.map(({ label, date }) => ({
          label,
          date: moment(date).format('YYYY-MM-DD'),
        })),
        lockedToDate: lockToDate,
      },
    );
  }
}
