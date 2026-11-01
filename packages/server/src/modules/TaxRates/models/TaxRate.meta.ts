/**
 * Tax rate fields for imports, exports and print.
 * Restored from the old `models/TaxRate.settings.ts` (removed in 55fcc908e).
 */
export const TaxRateMeta = {
  defaultSort: {
    sortOrder: 'DESC',
    sortField: 'created_at',
  },
  exportable: true,
  importable: true,
  print: {
    pageTitle: 'Tax Rates',
  },
  fields: {},
  columns: {
    name: {
      name: 'Tax Rate Name',
      type: 'text',
      accessor: 'name',
    },
    code: {
      name: 'Code',
      type: 'text',
      accessor: 'code',
    },
    rate: {
      name: 'Rate',
      type: 'text',
    },
    description: {
      name: 'Description',
      type: 'text',
    },
    isNonRecoverable: {
      name: 'Is Non Recoverable',
      type: 'boolean',
    },
    active: {
      name: 'Active',
      type: 'boolean',
    },
  },
  fields2: {
    name: {
      name: 'Tax Name',
      fieldType: 'text',
      required: true,
    },
    code: {
      name: 'Code',
      fieldType: 'text',
      required: true,
    },
    rate: {
      name: 'Rate',
      fieldType: 'number',
      required: true,
    },
    description: {
      name: 'Description',
      fieldType: 'text',
    },
    isNonRecoverable: {
      name: 'Is Non Recoverable',
      fieldType: 'boolean',
    },
    active: {
      name: 'Active',
      fieldType: 'boolean',
    },
  },
};
