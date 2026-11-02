import { IBankRuleEventDeletingPayload } from '../types';
import { Injectable } from '@nestjs/common';
import { RevertRecognizedTransactionsService } from '@/modules/BankingTranasctionsRegonize/commands/RevertRecognizedTransactions.service';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class UnlinkBankRuleOnDeleteBankRuleSubscriber {
  constructor(
    private readonly revertRecognizedTransactionsService: RevertRecognizedTransactionsService,
  ) {}

  /**
   * Unlinks the bank rule out of recognized transactions.
   * @param {IBankRuleEventDeletingPayload} payload -
   */
  @OnEvent(events.bankRules.onDeleting)
  public async unlinkBankRuleOutRecognizedTransactionsOnRuleDeleting({
    oldBankRule,
    trx,
  }: IBankRuleEventDeletingPayload) {
    // Runs inside the delete's transaction. Opening a second transaction
    // here would wait on rows the delete has locked (until the lock wait
    // timeout) when an account with bank rules is deleted.
    await this.revertRecognizedTransactionsService.revertRecognizedTransactions(
      oldBankRule.id,
      undefined,
      trx,
    );
  }
}
