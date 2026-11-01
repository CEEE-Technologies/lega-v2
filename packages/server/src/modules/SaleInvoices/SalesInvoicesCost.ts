import { Mutex } from 'async-mutex';
import * as moment from 'moment';
import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../Tenancy/TenancyDB/UnitOfWork.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { ModelObject } from 'objection';
import { InventoryTransaction } from '../InventoryCost/models/InventoryTransaction';
import { IInventoryCostLotsGLEntriesWriteEvent } from '../InventoryCost/types/InventoryCost.types';
import { InventoryComputeCostService } from '../InventoryCost/commands/InventoryComputeCost.service';

@Injectable()
export class SaleInvoicesCost {
  constructor(
    private readonly inventoryService: InventoryComputeCostService,
    private readonly uow: UnitOfWork,
    private readonly eventPublisher: EventEmitter2,
  ) {}

  /**
   * Schedule sale invoice re-compute based on the item
   * cost method and starting date.
   * @param {number[]} itemIds - Inventory items ids.
   * @param {Date} startingDate - Starting compute cost date.
   * @return {Promise<Agenda>}
   */
  async scheduleComputeCostByItemsIds(
    inventoryItemsIds: number[],
    startingDate: Date,
  ): Promise<void> {
    const mutex = new Mutex();
    const asyncOpers = inventoryItemsIds.map(
      async (inventoryItemId: number) => {
        // @todo refactor the lock acquire to be distrbuted using Redis
        // and run the cost schedule job after running invoice transaction.
        const release = await mutex.acquire();

        try {
          await this.inventoryService.scheduleComputeItemCost(
            inventoryItemId,
            startingDate,
          );
        } finally {
          release();
        }
      },
    );
    await Promise.all(asyncOpers);
  }

  /**
   * Retrieves the earliest dated inventory transaction of each item: the
   * cost is recomputed from that date onwards, so a later date would skip
   * the earlier movements.
   * @param {ModelObject<InventoryTransaction>[]} inventoryTransactions
   * @return {ModelObject<InventoryTransaction>[]}
   */
  getEarliestDateInventoryTransactions(
    inventoryTransactions: Pick<
      ModelObject<InventoryTransaction>,
      'itemId' | 'date'
    >[],
  ): Pick<ModelObject<InventoryTransaction>, 'itemId' | 'date'>[] {
    const reduced = inventoryTransactions.reduce(
      (acc, transaction) => {
        const existing = acc[transaction.itemId];

        if (!existing || moment(transaction.date).isBefore(existing.date)) {
          return { ...acc, [transaction.itemId]: { ...transaction } };
        }
        return acc;
      },
      {} as Record<
        number,
        Pick<ModelObject<InventoryTransaction>, 'itemId' | 'date'>
      >,
    );
    return Object.values(reduced);
  }

  /**
   * Schedules the items cost compute of the given inventory transactions,
   * each item from its earliest transaction date.
   * @param {ModelObject<InventoryTransaction>[]} inventoryTransactions
   */
  async scheduleComputeCostByInventoryTransactions(
    inventoryTransactions: Pick<
      ModelObject<InventoryTransaction>,
      'itemId' | 'date'
    >[],
  ) {
    const mutex = new Mutex();
    const reducedTransactions = this.getEarliestDateInventoryTransactions(
      inventoryTransactions,
    );
    const asyncOpers = reducedTransactions.map(async (transaction) => {
      const release = await mutex.acquire();

      try {
        await this.inventoryService.scheduleComputeItemCost(
          transaction.itemId,
          transaction.date,
        );
      } finally {
        release();
      }
    });
    await Promise.all([...asyncOpers]);
  }

  /**
   * Computes items costs by the given inventory transaction.
   * @param {IInventoryTransaction[]} inventoryTransactions
   */
  async computeItemsCostByInventoryTransactions(
    inventoryTransactions: ModelObject<InventoryTransaction>[],
  ) {
    return this.scheduleComputeCostByInventoryTransactions(
      inventoryTransactions,
    );
  }

  /**
   * Schedule writing journal entries.
   * @param {Date} startingDate - Starting date.
   * @return {Promise<agenda>}
   */
  scheduleWriteJournalEntries(_startingDate?: Date) {
    // const agenda = Container.get('agenda');
    // return agenda.schedule('in 3 seconds', 'rewrite-invoices-journal-entries', {
    //   startingDate,
    //   tenantId,
    // });
  }

  /**
   * Writes cost GL entries from the inventory cost lots.
   * @param {Date} startingDate - Starting date.
   * @returns {Promise<void>}
   */
  public writeCostLotsGLEntries = async (startingDate: Date) => {
    await this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Triggers event `onInventoryCostLotsGLEntriesBeforeWrite`.
      await this.eventPublisher.emitAsync(
        events.inventory.onCostLotsGLEntriesBeforeWrite,
        {
          startingDate,
          trx,
        } as IInventoryCostLotsGLEntriesWriteEvent,
      );
      // Triggers event `onInventoryCostLotsGLEntriesWrite`.
      await this.eventPublisher.emitAsync(
        events.inventory.onCostLotsGLEntriesWrite,
        {
          startingDate,
          trx,
        } as IInventoryCostLotsGLEntriesWriteEvent,
      );
    });
    // Signal that cost entries have been written so cost_compute_running can be set to false.
    await this.eventPublisher.emitAsync(
      events.inventory.onInventoryCostEntriesWritten,
      {},
    );
  };
}
