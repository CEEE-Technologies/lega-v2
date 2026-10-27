/**
 * Lets a line discount keep 2 decimals: `items_entries.discount` was an
 * unsigned integer, so a 2.5% discount was stored as 2% (or 3%) and a fixed
 * discount lost its cents. Widening the column keeps every stored value.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('items_entries', (table) => {
    table.decimal('discount', 13, 2).unsigned().nullable().alter();
  });
};

/**
 * Back to whole numbers (decimals are rounded by the database).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('items_entries', (table) => {
    table.integer('discount').unsigned().nullable().alter();
  });
};
