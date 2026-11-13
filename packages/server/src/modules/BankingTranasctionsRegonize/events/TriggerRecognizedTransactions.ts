import { isEqual, omit } from 'lodash';
import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IBankRuleEventCreatedPayload,
  IBankRuleEventDeletedPayload,
  IBankRuleEventEditedPayload,
} from '@/modules/BankRules/types';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import {
  RecognizeUncategorizedTransactionsJob,
  RecognizeUncategorizedTransactionsJobPayload,
  RecognizeUncategorizedTransactionsQueue,
} from '../_types';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';

@Injectable()
export class TriggerRecognizedTransactionsSubscriber {
  constructor(
    private readonly tenancyContect: TenancyContext,

    @InjectQueue(RecognizeUncategorizedTransactionsQueue)
    private readonly recognizeTransactionsQueue: Queue,
  ) {}

  /**
   * Triggers the recognize uncategorized transactions job on rule created.
   * @param {IBankRuleEventCreatedPayload} payload -
   */
  // Side effect (queues the bank-rules job): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onCreated, { suppressErrors: true })
  async recognizedTransactionsOnRuleCreated({
    bankRule,
    trx,
  }: IBankRuleEventCreatedPayload) {
    const tenantPayload = await this.tenancyContect.getTenantJobPayload();
    const payload = {
      ruleId: bankRule.id,
      ...tenantPayload,
    } as RecognizeUncategorizedTransactionsJobPayload;

    this.addJobAfterCommit(payload, trx);
  }

  /**
   * Triggers the recognize uncategorized transactions job on rule edited.
   * @param {IBankRuleEventEditedPayload} payload -
   */
  // Side effect (queues the bank-rules job): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onEdited, { suppressErrors: true })
  async recognizedTransactionsOnRuleEdited({
    editRuleDTO: _editRuleDTO,
    oldBankRule,
    bankRule,
    trx,
  }: IBankRuleEventEditedPayload) {
    // Cannot continue if the new and old bank rule values are the same,
    // after excluding `createdAt` and `updatedAt` dates.
    if (
      isEqual(
        omit(bankRule, ['createdAt', 'updatedAt']),
        omit(oldBankRule, ['createdAt', 'updatedAt']),
      )
    ) {
      return;
    }
    const tenantPayload = await this.tenancyContect.getTenantJobPayload();
    const payload = {
      ruleId: bankRule.id,
      shouldRevert: true,
      ...tenantPayload,
    } as RecognizeUncategorizedTransactionsJobPayload;

    // Re-recognize the transactions based on the new rules.
    // Setting shouldRevert to true ensures that transactions previously recognized
    // by this or lower-priority rules are re-evaluated against the updated rule.
    this.addJobAfterCommit(payload, trx);
  }

  /**
   * Triggers the recognize uncategorized transactions job on rule deleted.
   * @param {IBankRuleEventDeletedPayload} payload -
   */
  // Side effect (queues the bank-rules job): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onDeleted, { suppressErrors: true })
  async recognizedTransactionsOnRuleDeleted({
    ruleId,
    trx,
  }: IBankRuleEventDeletedPayload) {
    const tenantPayload = await this.tenancyContect.getTenantJobPayload();
    const payload = {
      ruleId,
      ...tenantPayload,
    } as RecognizeUncategorizedTransactionsJobPayload;

    // Re-recognize the transactions based on the new rules.
    this.addJobAfterCommit(payload, trx);
  }

  /**
   * Queues the job once the rule's save has committed (straight away when
   * there is no transaction). Queued earlier, a fast job could read the rule
   * before it was saved: miss a new rule, or re-apply the old one on edit.
   * A save that is rolled back queues nothing.
   * @param {RecognizeUncategorizedTransactionsJobPayload} payload
   * @param {Knex.Transaction} trx
   */
  private addJobAfterCommit(
    payload: RecognizeUncategorizedTransactionsJobPayload,
    trx?: Knex.Transaction,
  ) {
    runAfterTransaction(trx, () =>
      this.recognizeTransactionsQueue.add(
        RecognizeUncategorizedTransactionsJob,
        payload,
      ),
    );
  }

  /**
   * Triggers the recognize bank transactions once the imported file commit.
   * @param {IImportFileCommitedEventPayload} payload -
   */
  // Side effect (queues the bank-rules job): an error is logged and does not stop the save.
  @OnEvent(events.import.onImportCommitted, { suppressErrors: true })
  async triggerRecognizeTransactionsOnImportCommitted({
    importId: _importId,

    // @ts-ignore
  }: IImportFileCommitedEventPayload) {
    // const importFile = await Import.query().findOne({ importId });
    // const batch = importFile.paramsParsed.batch;
    // const payload = { transactionsCriteria: { batch } };
    // // Cannot continue if the imported resource is not bank account transactions.
    // if (importFile.resource !== 'UncategorizedCashflowTransaction') return;
    // await this.agenda.now('recognize-uncategorized-transactions-job', payload);
  }
}
