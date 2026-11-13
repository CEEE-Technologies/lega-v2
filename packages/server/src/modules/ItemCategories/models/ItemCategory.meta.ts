import { rawNumberFilterQuery } from '@/modules/DynamicListing/DynamicFilter/rawNumberFilterQuery';

export const ItemCategoryMeta = {
  defaultFilterField: 'name',
  defaultSort: {
    sortField: 'name',
    sortOrder: 'DESC',
  },
  importable: true,
  exportable: true,
  fields: {
    name: {
      name: 'item_category.field.name',
      column: 'name',
      fieldType: 'text',
    },
    description: {
      name: 'item_category.field.description',
      column: 'description',
      fieldType: 'text',
    },
    count: {
      name: 'item_category.field.count',
      column: 'count',
      fieldType: 'number',
      virtualColumn: true,
      // There is no count column: filter on the items count subquery
      // (identifiers upper-cased, as the knex snake-case mapper writes them).
      filterCustomQuery: rawNumberFilterQuery(
        '(SELECT COUNT(*) FROM ITEMS WHERE ITEMS.CATEGORY_ID = ITEMS_CATEGORIES.ID)',
      ),
    },
    created_at: {
      name: 'item_category.field.created_at',
      column: 'created_at',
      fieldType: 'date',
    },
  },
  columns: {
    name: {
      name: 'item_category.field.name',
      type: 'text',
    },
    description: {
      name: 'item_category.field.description',
      type: 'text',
    },
    count: {
      name: 'item_category.field.count',
      type: 'text',
    },
    createdAt: {
      name: 'item_category.field.created_at',
      type: 'text',
    },
  },
  fields2: {
    name: {
      name: 'item_category.field.name',
      column: 'name',
      fieldType: 'text',
    },
    description: {
      name: 'item_category.field.description',
      column: 'description',
      fieldType: 'text',
    },
  },
};
