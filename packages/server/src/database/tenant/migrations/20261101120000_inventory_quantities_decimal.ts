/**
 * Lets the remaining stock quantities keep 3 decimals, like the item, the
 * document lines and the stock movements already do. These columns were
 * whole numbers, so adjusting stock by 2.5 kg saved 2 and per-warehouse
 * stock drifted away from the item's total:
 * - items_warehouses_quantity.quantity_on_hand (stock per warehouse),
 * - inventory_adjustments_entries.quantity,
 * - warehouses_transfers_entries.quantity,
 * - accounts_transactions.item_quantity (ledger rows),
 * - inventory_cost_lot_tracker.remaining (cost lots).
 * Widening the columns keeps every stored value.
 *
 * The per-unit rates of the stock movements and cost lots also get 8
 * decimals (were 3): a lot's cost is rate x quantity, so 30 units bought
 * for 100.00 stored 3.333 and costed 99.99, leaving stock a cent or more
 * off after everything was sold. The ledger still posts whole cents.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('items_warehouses_quantity', (table) => {
    table.decimal('quantity_on_hand', 13, 3).nullable().alter();
  });
  await knex.schema.alterTable('inventory_adjustments_entries', (table) => {
    table.decimal('quantity', 13, 3).nullable().alter();
  });
  await knex.schema.alterTable('warehouses_transfers_entries', (table) => {
    table.decimal('quantity', 13, 3).nullable().alter();
  });
  await knex.schema.alterTable('accounts_transactions', (table) => {
    table.decimal('item_quantity', 13, 3).unsigned().nullable().alter();
  });
  await knex.schema.alterTable('inventory_cost_lot_tracker', (table) => {
    table.decimal('remaining', 13, 3).nullable().alter();
    table.decimal('rate', 19, 8).nullable().alter();
  });
  await knex.schema.alterTable('inventory_transactions', (table) => {
    table.decimal('rate', 19, 8).unsigned().nullable().alter();
  });
};

/**
 * Back to whole numbers (decimals are rounded by the database).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('items_warehouses_quantity', (table) => {
    table.integer('quantity_on_hand').nullable().alter();
  });
  await knex.schema.alterTable('inventory_adjustments_entries', (table) => {
    table.integer('quantity').nullable().alter();
  });
  await knex.schema.alterTable('warehouses_transfers_entries', (table) => {
    table.integer('quantity').nullable().alter();
  });
  await knex.schema.alterTable('accounts_transactions', (table) => {
    table.integer('item_quantity').unsigned().nullable().alter();
  });
  await knex.schema.alterTable('inventory_cost_lot_tracker', (table) => {
    table.integer('remaining').nullable().alter();
    table.decimal('rate', 13, 3).nullable().alter();
  });
  await knex.schema.alterTable('inventory_transactions', (table) => {
    table.decimal('rate', 13, 3).unsigned().nullable().alter();
  });
};
