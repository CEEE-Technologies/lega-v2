import { OnEvent } from '@nestjs/event-emitter';
import {
  IComputeItemCostJobCompletedPayload,
  IInventoryTransactionsCreatedPayload,
  IInventoryTransactionsDeletedPayload,
} from '../types/InventoryCost.types';
import { ImportAls } from '@/modules/Import/ImportALS';
import { InventoryItemsQuantitySyncService } from '../commands/InventoryItemsQuantitySync.service';
import { SaleInvoicesCost } from '@/modules/SaleInvoices/SalesInvoicesCost';
import { events } from '@/common/events/events';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';
import { Injectable } from '@nestjs/common';
import { InventoryComputeCostService } from '../commands/InventoryComputeCost.service';

@Injectable()
export class InventoryCostSubscriber {
  constructor(
    private readonly saleInvoicesCost: SaleInvoicesCost,
    private readonly itemsQuantitySync: InventoryItemsQuantitySyncService,
    private readonly inventoryService: InventoryComputeCostService,
    private readonly importAls: ImportAls,
  ) {}

  /**
   * Sync inventory items quantity once inventory transactions created.
   * @param {IInventoryTransactionsCreatedPayload} payload -
   */
  @OnEvent(events.inventory.onInventoryTransactionsCreated)
  async syncItemsQuantityOnceInventoryTransactionsCreated({
    inventoryTransactions,
    trx,
  }: IInventoryTransactionsCreatedPayload) {
    const itemsQuantityChanges = this.itemsQuantitySync.getItemsQuantityChanges(
      inventoryTransactions,
    );
    await this.itemsQuantitySync.changeItemsQuantity(itemsQuantityChanges, trx);
  }

  /**
   * Schedules the items cost compute once the inventory transactions are
   * created and the save is committed. A dry run, an import preview or a
   * failed save schedules nothing, and leaves the "cost computing" flag off.
   * @param {IInventoryTransactionsCreatedPayload} payload -
   */
  @OnEvent(events.inventory.onInventoryTransactionsCreated)
  async handleScheduleItemsCostOnInventoryTransactionsCreated({
    inventoryTransactions,
    trx,
  }: IInventoryTransactionsCreatedPayload) {
    // Avoid running the cost items job if the async process is in import preview.
    if (this.importAls.isImportPreview) return;

    runAfterTransaction(trx, () =>
      this.markRunningAndSchedule(() =>
        this.saleInvoicesCost.computeItemsCostByInventoryTransactions(
          inventoryTransactions,
        ),
      ),
    );
  }

  /**
   * Sets the "cost computing" flag, then schedules the cost job. The flag
   * is only set when a job is scheduled, since the job is what clears it.
   * @param {() => Promise<void>} schedule
   */
  private async markRunningAndSchedule(schedule: () => Promise<void>) {
    try {
      await this.inventoryService.markItemsCostComputeRunning(true);
      await schedule();
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Marks items cost compute as completed.
   */
  @OnEvent(events.inventory.onInventoryCostEntriesWritten)
  async markGlobalSettingsComputeItemsCompeted({}) {
    await this.inventoryService.markItemsCostComputeRunning(false);
  }

  /**
   * Handle run writing the journal entries once the compute items jobs completed.
   */
  @OnEvent(events.inventory.onComputeItemCostJobCompleted)
  async onComputeItemCostJobFinished({
    startingDate,
  }: IComputeItemCostJobCompletedPayload) {
    // Convert startingDate to Date if it's a string
    const startingDateObj =
      startingDate instanceof Date ? startingDate : new Date(startingDate);

    // Write GL entries for inventory cost lots after cost computation completes
    await this.saleInvoicesCost.writeCostLotsGLEntries(startingDateObj);
  }

  /**
   * Sync inventory items quantity once inventory transactions deleted.
   */
  @OnEvent(events.inventory.onInventoryTransactionsDeleted)
  async syncItemsQuantityOnceInventoryTransactionsDeleted({
    oldInventoryTransactions,
    trx,
  }: IInventoryTransactionsDeletedPayload) {
    const itemsQuantityChanges =
      this.itemsQuantitySync.getReverseItemsQuantityChanges(
        oldInventoryTransactions,
      );
    await this.itemsQuantitySync.changeItemsQuantity(itemsQuantityChanges, trx);
  }

  /**
   * Schedules compute items cost once the inventory transactions deleted.
   */
  @OnEvent(events.inventory.onInventoryTransactionsDeleted)
  async handleScheduleItemsCostOnInventoryTransactionsDeleted({
    transactionType,
    oldInventoryTransactions,
    trx,
  }: IInventoryTransactionsDeletedPayload) {
    // Ignore compute item cost with theses transaction types.
    const ignoreWithTransactionTypes = ['OpeningItem'];

    if (ignoreWithTransactionTypes.indexOf(transactionType) !== -1) {
      return;
    }
    // Nothing to recompute when the document had no stock movements.
    if (!oldInventoryTransactions?.length) {
      return;
    }
    runAfterTransaction(trx, () =>
      // Each item from the earliest date of its removed movements.
      this.markRunningAndSchedule(() =>
        this.saleInvoicesCost.scheduleComputeCostByInventoryTransactions(
          oldInventoryTransactions,
        ),
      ),
    );
  }
}
