/**
 * One stock row per item and warehouse (Q3, decision D9).
 *
 * Nothing stopped two rows for the same item and warehouse in
 * `items_warehouses_quantity`: the first stock movement read, then
 * inserted, so two movements at the same moment both inserted, and every
 * later change updated both rows (the warehouse showed double the stock).
 *
 * 1. Rows of the same item and warehouse are merged into one row whose
 *    quantity is the sum of theirs. Each merge is printed.
 * 2. A unique index on (item, warehouse) is added. The app now adds to the
 *    existing row in one step ("insert, or add to the existing row").
 *
 * Rows with no item or no warehouse are left alone (the index allows
 * them, and they aren't stock of any warehouse).
 *
 * Safe to re-run: an index that already exists is skipped.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const TABLE = 'items_warehouses_quantity';
const INDEX = 'items_warehouses_quantity_item_id_warehouse_id_unique';

// Identifiers go through `??` bindings: the tenant knex maps them to the
// stored (upper case) names, as it does for the query builder.

/** knex.raw on MySQL resolves to [rows, fields]. */
const rawRows = (result: any): any[] =>
  Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;

const hasIndex = async (knex): Promise<boolean> => {
  const rows = rawRows(
    await knex.raw(
      `SELECT 1 AS found FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND UPPER(table_name) = UPPER(?)
          AND UPPER(index_name) = UPPER(?)`,
      [TABLE, INDEX],
    ),
  );
  return rows.length > 0;
};

exports.up = async function (knex) {
  if (await hasIndex(knex)) return;

  await knex.transaction(async (trx) => {
    const duplicates = rawRows(
      await trx.raw(
        `SELECT ?? AS i, ?? AS w, SUM(??) AS q, COUNT(*) AS n
           FROM ??
          WHERE ?? IS NOT NULL AND ?? IS NOT NULL
          GROUP BY ??, ??
         HAVING COUNT(*) > 1`,
        [
          'item_id',
          'warehouse_id',
          'quantity_on_hand',
          TABLE,
          'item_id',
          'warehouse_id',
          'item_id',
          'warehouse_id',
        ],
      ),
    );
    for (const row of duplicates) {
      await trx(TABLE).where({ item_id: row.i, warehouse_id: row.w }).delete();
      await trx(TABLE).insert({
        item_id: row.i,
        warehouse_id: row.w,
        quantity_on_hand: row.q,
      });
      console.log(
        `[items_warehouses_quantity] item ${row.i} / warehouse ${row.w}: merged ${row.n} rows into one of ${row.q}.`,
      );
    }
  });
  await knex.schema.alterTable(TABLE, (table) => {
    table.unique(['item_id', 'warehouse_id'], { indexName: INDEX });
  });
};

/**
 * Whether another index starts with `item_id` (the foreign key to the
 * items needs one).
 */
const hasOtherItemIndex = async (knex): Promise<boolean> => {
  const rows = rawRows(
    await knex.raw(
      `SELECT 1 AS found FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND UPPER(table_name) = UPPER(?)
          AND UPPER(index_name) <> UPPER(?)
          AND UPPER(column_name) = 'ITEM_ID'
          AND seq_in_index = 1`,
      [TABLE, INDEX],
    ),
  );
  return rows.length > 0;
};

/**
 * Drops the unique index. Merged rows stay merged (their total is right).
 *
 * The database dropped the index it made for the `item_id` foreign key
 * once the unique index could serve it, so that index is added back first
 * (the foreign key can't lose its index).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  if (!(await hasIndex(knex))) return;

  if (!(await hasOtherItemIndex(knex))) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.index(['item_id'], 'items_warehouses_quantity_item_id_foreign');
    });
  }
  await knex.schema.alterTable(TABLE, (table) => {
    table.dropUnique(['item_id', 'warehouse_id'], INDEX);
  });
};
