import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InventoryAdjustmentsGLEntries } from '../commands/ledger/InventoryAdjustmentsGLEntries';
import {
  IInventoryAdjustmentDeletingPayload,
  IInventoryAdjustmentEditedPayload,
} from '../types/InventoryAdjustments.types';
import { IInventoryAdjustmentEventCreatedPayload } from '../types/InventoryAdjustments.types';
import { events } from '@/common/events/events';
import { IInventoryCostLotsGLEntriesWriteEvent } from '@/modules/InventoryCost/types/InventoryCost.types';
import { InventoryAdjustmentCostGLEntries } from '../commands/ledger/InventoryAdjustmentCostGLEntries';

@Injectable()
export class InventoryAdjustmentsGLSubscriber {
  constructor(
    private readonly inventoryAdjustmentGL: InventoryAdjustmentsGLEntries,
    private readonly inventoryAdjustmentCostGL: InventoryAdjustmentCostGLEntries,
  ) {}

  /**
   * Writes the decrease adjustments cost entries once the cost lots are
   * written: a decrease takes the units out at their average cost.
   * @param {IInventoryCostLotsGLEntriesWriteEvent} payload -
   */
  @OnEvent(events.inventory.onCostLotsGLEntriesWrite)
  async writeDecrementAdjustmentsCostEntries({
    trx,
    startingDate,
  }: IInventoryCostLotsGLEntriesWriteEvent) {
    await this.inventoryAdjustmentCostGL.writeInventoryCostJournalEntries(
      startingDate,
      trx,
    );
  }

  /**
   * Handles writing increment inventory adjustment GL entries.
   * @param {IInventoryAdjustmentEventCreatedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onQuickCreated)
  @OnEvent(events.inventoryAdjustment.onPublished)
  async handleGLEntriesOnceIncrementAdjustmentCreated({
    inventoryAdjustmentId,
    inventoryAdjustment,
    trx,
  }: IInventoryAdjustmentEventCreatedPayload) {
    // Can't continue if the inventory adjustment is not published.
    if (!inventoryAdjustment.isPublished) {
      return;
    }
    // Can't continue if the inventory adjustment direction is not `IN`.
    if (inventoryAdjustment.type !== 'increment') {
      return;
    }
    await this.inventoryAdjustmentGL.writeAdjustmentGLEntries(
      inventoryAdjustmentId,
      trx,
    );
  }

  /**
   * Rewrites the inventory adjustment GL entries once the transaction edited.
   * @param {IInventoryAdjustmentEditedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onEdited)
  async rewriteAdjustmentGLEntriesOnceEdited({
    inventoryAdjustmentId,
    inventoryAdjustment,
    oldInventoryAdjustment,
    trx,
  }: IInventoryAdjustmentEditedPayload) {
    // Can't continue if the old inventory adjustment was not published.
    if (oldInventoryAdjustment.isPublished) {
      await this.inventoryAdjustmentGL.revertAdjustmentGLEntries(
        inventoryAdjustmentId,
        trx,
      );
    }
    // Can't continue if the new inventory adjustment is not published or
    // the direction is not `IN`.
    if (
      !inventoryAdjustment.isPublished ||
      inventoryAdjustment.type !== 'increment'
    ) {
      return;
    }
    await this.inventoryAdjustmentGL.writeAdjustmentGLEntries(
      inventoryAdjustmentId,
      trx,
    );
  }

  /**
   * Reverts the inventory adjustment GL entries once the transaction deleted.
   * @param {IInventoryAdjustmentDeletingPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onDeleting)
  async revertAdjustmentGLEntriesOnceDeleted({
    inventoryAdjustment,
    trx,
  }: IInventoryAdjustmentDeletingPayload) {
    // Can't continue if the inventory adjustment is not published.
    if (!inventoryAdjustment.isPublished) {
      return;
    }
    await this.inventoryAdjustmentGL.revertAdjustmentGLEntries(
      inventoryAdjustment.id,
      trx,
    );
  }
}
