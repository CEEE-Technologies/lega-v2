import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { UpdateInventoryTransactionsWithWarehouse } from './UpdateInventoryTransactionsWithWarehouse';
import { CreateInitialWarehousesItemsQuantity } from './CreateInitialWarehousesitemsQuantity';
import { IWarehousesActivatedPayload } from './Warehouse.types';

@Injectable()
export class ActivateWarehousesSubscriber {
  constructor(
    private readonly updateInventoryTransactionsWithWarehouse: UpdateInventoryTransactionsWithWarehouse,
    private readonly createInitialWarehousesItemsQuantity: CreateInitialWarehousesItemsQuantity,
  ) {}

  /**
   * Updates inventory transactiont to primary warehouse once
   * multi-warehouses activated.
   * @param {IWarehousesActivatedPayload}
   */
  @OnEvent(events.warehouse.onActivated)
  async updateInventoryTransactionsWithWarehouseOnActivating({
    primaryWarehouse,
    trx,
  }: IWarehousesActivatedPayload) {
    await this.updateInventoryTransactionsWithWarehouse.run(
      primaryWarehouse.id,
      trx,
    );
  }

  /**
   * Creates initial warehouses items quantity once the multi-warehouses activated.
   * @param {IWarehousesActivatedPayload}
   */
  @OnEvent(events.warehouse.onActivated)
  async createInitialWarehousesItemsQuantityOnActivating({
    primaryWarehouse,
    trx,
  }: IWarehousesActivatedPayload) {
    await this.createInitialWarehousesItemsQuantity.run(
      primaryWarehouse.id,
      trx,
    );
  }
}
