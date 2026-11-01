import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BankTransactionGLEntriesService } from '../commands/BankTransactionGLEntries';
import { events } from '@/common/events/events';
import {
  ICommandCashflowCreatedPayload,
  ICommandCashflowDeletedPayload,
} from '../types/BankingTransactions.types';

@Injectable()
export class BankingTransactionGLEntriesSubscriber {
  /**
   * @param {BankTransactionGLEntriesService} bankTransactionGLEntries - Bank transaction GL entries service.
   */
  constructor(
    private readonly bankTransactionGLEntries: BankTransactionGLEntriesService,
  ) {}

  /**
   * Writes the journal entries once the cashflow transaction create.
   * @param {ICommandCashflowCreatedPayload} payload -
   */
  @OnEvent(events.cashflow.onTransactionCreated)
  public async writeJournalEntriesOnceTransactionCreated({
    cashflowTransaction,
    trx,
  }: ICommandCashflowCreatedPayload) {
    // Can't write GL entries if the transaction not published yet.
    if (!cashflowTransaction.isPublished) return;

    await this.bankTransactionGLEntries.writeJournalEntries(
      cashflowTransaction.id,
      trx,
    );
  }

  /**
   * Deletes the GL entries once the cashflow transaction deleted.
   * @param {ICommandCashflowDeletedPayload} payload -
   */
  @OnEvent(events.cashflow.onTransactionDeleted)
  public async revertGLEntriesOnceTransactionDeleted({
    cashflowTransactionId,
    trx,
  }: ICommandCashflowDeletedPayload) {
    await this.bankTransactionGLEntries.revertJournalEntries(
      cashflowTransactionId,
      trx,
    );
  }
}
