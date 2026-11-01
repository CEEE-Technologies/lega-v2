import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { IInventoryCostLotsGLEntriesWriteEvent } from '@/modules/InventoryCost/types/InventoryCost.types';
import { CreditNoteCostGLEntries } from '../commands/CreditNoteCostGLEntries';

@Injectable()
export class CreditNoteCostGLEntriesSubscriber {
  constructor(
    private readonly creditNoteCostEntries: CreditNoteCostGLEntries,
  ) {}

  /**
   * Writes the credit notes cost entries once the cost lots are written.
   * @param {IInventoryCostLotsGLEntriesWriteEvent}
   */
  @OnEvent(events.inventory.onCostLotsGLEntriesWrite)
  async writeCreditNotesCostEntriesOnCostLotsWritten({
    trx,
    startingDate,
  }: IInventoryCostLotsGLEntriesWriteEvent) {
    await this.creditNoteCostEntries.writeInventoryCostJournalEntries(
      startingDate,
      trx,
    );
  }
}
