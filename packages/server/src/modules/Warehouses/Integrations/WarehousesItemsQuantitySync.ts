import { InventoryTransaction } from '@/modules/InventoryCost/models/InventoryTransaction';
import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { IItemWarehouseQuantityChange } from '../Warehouse.types';
import { WarehousesItemsQuantity } from './WarehousesItemsQuantity';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { ItemWarehouseQuantity } from '../models/ItemWarehouseQuantity';

@Injectable()
export class WarehousesItemsQuantitySync {
  constructor(
    @Inject(ItemWarehouseQuantity.name)
    private readonly itemWarehouseQuantityModel: TenantModelProxy<
      typeof ItemWarehouseQuantity
    >,
  ) {}

  /**
   * Retrieves the reversed warehouses items quantity changes.
   * @param {InventoryTransaction[]} inventoryTransactions
   * @returns {IItemWarehouseQuantityChange[]}
   */
  public getReverseWarehousesItemsQuantityChanges = (
    inventoryTransactions: InventoryTransaction[],
  ): IItemWarehouseQuantityChange[] => {
    const warehouseItemsQuantity =
      WarehousesItemsQuantity.fromInventoryTransaction(inventoryTransactions);

    return warehouseItemsQuantity.reverse().toArray();
  };

  /**
   * Retrieves the warehouses items changes from the given inventory tranasctions.
   * @param {InventoryTransaction[]} inventoryTransactions
   * @returns {IItemWarehouseQuantityChange[]}
   */
  public getWarehousesItemsQuantityChange = (
    inventoryTransactions: InventoryTransaction[],
  ): IItemWarehouseQuantityChange[] => {
    const warehouseItemsQuantity =
      WarehousesItemsQuantity.fromInventoryTransaction(inventoryTransactions);

    return warehouseItemsQuantity.toArray();
  };

  /**
   * Mutates warehouses items quantity on hand on the storage.
   * @param {IItemWarehouseQuantityChange[]} warehousesItemsQuantity
   * @param {Knex.Transaction} trx
   */
  public mutateWarehousesItemsQuantity = async (
    warehousesItemsQuantity: IItemWarehouseQuantityChange[],
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const mutationsOpers = warehousesItemsQuantity.map(
      (change: IItemWarehouseQuantityChange) =>
        this.mutateWarehouseItemQuantity(change, trx),
    );
    await Promise.all(mutationsOpers);
  };

  /**
   * Mutates the warehouse item quantity.
   *
   * There is one row per item and warehouse (unique index, migration
   * `20261107130000`). Two first movements at the same moment used to both
   * read "no row" and both insert, and every later change then updated
   * both rows (double the stock). Now:
   * 1. the change is added to the existing row;
   * 2. if there is none, the row is inserted, or, when another movement
   *    inserted it in the meantime, the change is added to that row (the
   *    unique index makes the insert wait for it).
   * Step 1 keeps a company whose database doesn't have the index yet
   * working as before.
   * @param {number} warehouseItemQuantity
   * @param {Knex.Transaction} trx
   */
  public mutateWarehouseItemQuantity = async (
    warehouseItemQuantity: IItemWarehouseQuantityChange,
    trx: Knex.Transaction,
  ): Promise<void> => {
    const { itemId, warehouseId, amount } = warehouseItemQuantity;
    if (!amount) return;

    const knex = trx ?? this.itemWarehouseQuantityModel().knex();

    const updated = await this.itemWarehouseQuantityModel()
      .query(trx)
      .where({ itemId, warehouseId })
      .patch({
        quantityOnHand: knex.raw('COALESCE(??, 0) + ?', [
          'quantity_on_hand',
          amount,
        ]),
      } as any);
    if (updated > 0) return;

    // Identifiers as `??` bindings, so the tenant knex maps their names.
    await knex.raw(
      `INSERT INTO ?? (??, ??, ??) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ?? = COALESCE(??, 0) + VALUES(??)`,
      [
        'items_warehouses_quantity',
        'item_id',
        'warehouse_id',
        'quantity_on_hand',
        itemId,
        warehouseId,
        amount,
        'quantity_on_hand',
        'quantity_on_hand',
        'quantity_on_hand',
      ],
    );
  };

  /**
   * Mutates warehouses items quantity from inventory transactions.
   * @param {IInventoryTransaction[]} inventoryTransactions -
   * @param {Knex.Transaction}
   */
  public mutateWarehousesItemsQuantityFromTransactions = async (
    inventoryTransactions: InventoryTransaction[],
    trx?: Knex.Transaction,
  ) => {
    const changes = this.getWarehousesItemsQuantityChange(
      inventoryTransactions,
    );
    await this.mutateWarehousesItemsQuantity(changes, trx);
  };

  /**
   * Reverses warehouses items quantity from inventory transactions.
   * @param {number} tenantId
   * @param {IInventoryTransaction[]} inventoryTransactions
   * @param {Knex.Transaction} trx
   */
  public reverseWarehousesItemsQuantityFromTransactions = async (
    inventoryTransactions: InventoryTransaction[],
    trx?: Knex.Transaction,
  ) => {
    const changes = this.getReverseWarehousesItemsQuantityChanges(
      inventoryTransactions,
    );
    await this.mutateWarehousesItemsQuantity(changes, trx);
  };
}
