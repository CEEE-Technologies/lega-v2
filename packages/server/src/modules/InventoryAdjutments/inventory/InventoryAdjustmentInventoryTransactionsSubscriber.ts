import { Injectable } from '@nestjs/common';
import {
  IInventoryAdjustmentEditedPayload,
  IInventoryAdjustmentEventCreatedPayload,
  IInventoryAdjustmentEventPublishedPayload,
} from '../types/InventoryAdjustments.types';
import { IInventoryAdjustmentEventDeletedPayload } from '../types/InventoryAdjustments.types';
import { InventoryAdjustmentInventoryTransactions } from './InventoryAdjustmentInventoryTransactions';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class InventoryAdjustmentInventoryTransactionsSubscriber {
  constructor(
    private readonly inventoryTransactions: InventoryAdjustmentInventoryTransactions,
  ) {}

  /**
   * Writes the stock movement once a published adjustment is created. A
   * draft has no effect on stock until it is published.
   * @param {IInventoryAdjustmentEventCreatedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onQuickCreated)
  public async handleWriteInventoryTransactionsOnceCreated({
    inventoryAdjustment,
    trx,
  }: IInventoryAdjustmentEventCreatedPayload) {
    if (!inventoryAdjustment.isPublished) {
      return;
    }
    await this.inventoryTransactions.writeInventoryTransactions(
      inventoryAdjustment,
      false,
      trx,
    );
  }

  /**
   * Writes the stock movement once a draft adjustment is published. It
   * overrides, as drafts saved before this fix may have moved stock already.
   * @param {IInventoryAdjustmentEventPublishedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onPublished)
  public async handleWriteInventoryTransactionsOncePublished({
    inventoryAdjustment,
    trx,
  }: IInventoryAdjustmentEventPublishedPayload) {
    await this.inventoryTransactions.writeInventoryTransactions(
      inventoryAdjustment,
      true,
      trx,
    );
  }

  /**
   * Rewrites the stock movement once the adjustment is edited, only when
   * it is published. An edited draft clears any movement it still has.
   * @param {IInventoryAdjustmentEditedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onEdited)
  public async handleRewriteInventoryTransactionsOnceEdited({
    inventoryAdjustment,
    trx,
  }: IInventoryAdjustmentEditedPayload) {
    if (!inventoryAdjustment.isPublished) {
      await this.inventoryTransactions.revertInventoryTransactions(
        inventoryAdjustment.id,
        trx,
      );
      return;
    }
    await this.inventoryTransactions.writeInventoryTransactions(
      inventoryAdjustment,
      true,
      trx,
    );
  }

  /**
   * Undoes the stock movement once the adjustment is deleted, draft or
   * published (drafts saved before this fix may have moved stock).
   * @param {IInventoryAdjustmentEventDeletedPayload} payload -
   */
  @OnEvent(events.inventoryAdjustment.onDeleted)
  public async handleRevertInventoryTransactionsOnceDeleted({
    inventoryAdjustmentId,
    trx,
  }: IInventoryAdjustmentEventDeletedPayload) {
    await this.inventoryTransactions.revertInventoryTransactions(
      inventoryAdjustmentId,
      trx,
    );
  }
}
