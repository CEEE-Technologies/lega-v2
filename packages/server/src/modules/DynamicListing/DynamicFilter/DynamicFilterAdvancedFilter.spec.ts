import knexFactory from 'knex';
import { DynamicFilterAdvancedFilter } from './DynamicFilterAdvancedFilter';
import { rawNumberFilterQuery } from './rawNumberFilterQuery';
import { parseFilterDate } from './DynamicFilterRoleAbstractor';
import { DynamicFilter } from './DynamicFilter';
import { DynamicFilterSortBy } from './DynamicFilterSortBy';

const knex = knexFactory({ client: 'mysql2' });

const statusFilter = jest.fn((query, role) =>
  query.where('sales_invoices.status', role.value),
);

const FIELDS: Record<string, any> = {
  invoice_no: { column: 'invoice_no', fieldType: 'text' },
  amount: { column: 'balance', fieldType: 'number' },
  invoice_date: { column: 'invoice_date', fieldType: 'date' },
  sellable: { column: 'sellable', fieldType: 'boolean' },
  type: { column: 'type', fieldType: 'enumeration' },
  status: { fieldType: 'enumeration', filterCustomQuery: statusFilter },
  due_amount: {
    column: 'due_amount',
    fieldType: 'number',
    filterCustomQuery: rawNumberFilterQuery('(TOTAL - PAID)'),
  },
  customer: {
    column: 'customer_id',
    fieldType: 'relation',
    relationKey: 'customer',
    relationEntityLabel: 'display_name',
    relationEntityKey: 'id',
  },
};

const model = {
  tableName: 'sales_invoices',
  relationMappings: {
    customer: {
      modelClass: { getField: () => undefined },
      join: { from: 'sales_invoices.customer_id', to: 'contacts.id' },
    },
  },
  getField: (key: string) => FIELDS[key],
} as any;

const role = (
  fieldKey: string,
  comparator: string,
  value: any,
  condition = 'and',
) => ({ fieldKey, comparator, value, condition });

/** The SQL `where` the given filter roles build. */
const whereSql = (...roles: any[]) => {
  const filter = new DynamicFilterAdvancedFilter(
    roles.map((r, index) => ({ ...r, index: index + 1 })),
  );
  filter.setModel(model);
  filter.onInitialize();

  const query = knex('sales_invoices');
  filter.buildQuery()(query);
  return query.toString().replace('select * from `sales_invoices` where ', '');
};

describe('DynamicFilterAdvancedFilter', () => {
  describe('text fields', () => {
    it.each([
      ['contain', "`sales_invoices`.`invoice_no` like '%INV%'"],
      ['equal', "`sales_invoices`.`invoice_no` = 'INV'"],
      ['starts_with', "`sales_invoices`.`invoice_no` like 'INV%'"],
      ['ends_with', "`sales_invoices`.`invoice_no` like '%INV'"],
    ])('%s', (comparator, sql) => {
      expect(whereSql(role('invoice_no', comparator, 'INV'))).toBe(sql);
    });

    it('"does not contain" excludes matches and keeps empty values', () => {
      expect(whereSql(role('invoice_no', 'not_contain', 'INV'))).toBe(
        "(not `sales_invoices`.`invoice_no` like '%INV%' or `sales_invoices`.`invoice_no` is null)",
      );
    });

    it('"not equal" keeps empty values', () => {
      expect(whereSql(role('invoice_no', 'not_equal', 'INV'))).toBe(
        "(not `sales_invoices`.`invoice_no` = 'INV' or `sales_invoices`.`invoice_no` is null)",
      );
    });
  });

  describe('number fields', () => {
    it.each([
      ['equal', '='],
      ['bigger_than', '>'],
      ['bigger_or_equal', '>='],
      ['bigger_or_equals', '>='],
      ['smaller_than', '<'],
      ['smaller_or_equal', '<='],
      ['smaller_or_equals', '<='],
    ])('%s uses %s', (comparator, operator) => {
      expect(whereSql(role('amount', comparator, '250'))).toBe(
        `COALESCE(\`sales_invoices\`.\`balance\`, 0) ${operator} 250`,
      );
    });

    it('"not equal" counts an empty amount as 0', () => {
      expect(whereSql(role('amount', 'not_equal', '0'))).toBe(
        'COALESCE(`sales_invoices`.`balance`, 0) <> 0',
      );
    });

    it('a value that is not a number matches nothing', () => {
      expect(whereSql(role('amount', 'bigger_than', 'abc'))).toBe('1 = 0');
    });

    it('a computed amount compares its SQL expression', () => {
      expect(whereSql(role('due_amount', 'bigger_or_equal', '10'))).toBe(
        '`sales_invoices`.`id` in (select `sales_invoices`.`id` from `sales_invoices` where (TOTAL - PAID) >= 10)',
      );
    });

    it('a computed amount with no number matches nothing', () => {
      expect(whereSql(role('due_amount', 'equal', 'abc'))).toBe(
        '`sales_invoices`.`id` in (select `sales_invoices`.`id` from `sales_invoices` where 1 = 0)',
      );
    });
  });

  describe('date fields', () => {
    it('"in" covers the whole day, from the popover\'s YYYY/MM/DD', () => {
      expect(whereSql(role('invoice_date', 'in', '2026/11/05'))).toBe(
        "`sales_invoices`.`invoice_date` >= '2026-11-05 00:00:00' and `sales_invoices`.`invoice_date` <= '2026-11-05 23:59:59'",
      );
    });

    it('"after" a day starts after its end', () => {
      expect(whereSql(role('invoice_date', 'after', '2026-11-04'))).toBe(
        "`sales_invoices`.`invoice_date` > '2026-11-04 23:59:59'",
      );
    });

    it('"before" a day ends before its start', () => {
      expect(whereSql(role('invoice_date', 'before', '2026/11/06'))).toBe(
        "`sales_invoices`.`invoice_date` < '2026-11-06 00:00:00'",
      );
    });

    it('a date with a time compares to the minute', () => {
      expect(whereSql(role('invoice_date', 'in', '2026-11-05 14:30'))).toBe(
        "`sales_invoices`.`invoice_date` >= '2026-11-05 14:30:00' and `sales_invoices`.`invoice_date` <= '2026-11-05 14:30:59'",
      );
    });

    it('an invalid date matches nothing', () => {
      expect(whereSql(role('invoice_date', 'in', 'not a date'))).toBe('1 = 0');
    });

    it('parses both date separators', () => {
      expect(parseFilterDate('2026/11/05').date.format('YYYY-MM-DD')).toBe(
        '2026-11-05',
      );
      expect(parseFilterDate('2026-11-05').hasTime).toBe(false);
    });
  });

  describe('enumeration and boolean fields', () => {
    it('"is" and "is not" on a column', () => {
      expect(whereSql(role('type', 'is', 'service'))).toBe(
        "`sales_invoices`.`type` = 'service'",
      );
      expect(whereSql(role('type', 'is_not', 'service'))).toBe(
        "`sales_invoices`.`type` <> 'service'",
      );
      expect(whereSql(role('sellable', 'is', false))).toBe(
        '`sales_invoices`.`sellable` = false',
      );
    });

    it('a custom status query runs in a subquery on the list table for "is"', () => {
      expect(whereSql(role('status', 'is', 'draft'))).toBe(
        "`sales_invoices`.`id` in (select `sales_invoices`.`id` from `sales_invoices` where `sales_invoices`.`status` = 'draft')",
      );
    });

    it('a custom status query is negated (NOT IN) for "is not"', () => {
      expect(whereSql(role('status', 'is_not', 'draft'))).toBe(
        "`sales_invoices`.`id` not in (select `sales_invoices`.`id` from `sales_invoices` where `sales_invoices`.`status` = 'draft')",
      );
    });
  });

  describe('relation fields', () => {
    it('match the typed text against the related label', () => {
      expect(whereSql(role('customer', 'contain', 'Alpha'))).toBe(
        "`sales_invoices`.`customer_id` in (select `contacts`.`id` from `contacts` where `contacts`.`display_name` like '%Alpha%')",
      );
    });

    it('a negative comparator excludes matches and keeps rows without one', () => {
      expect(whereSql(role('customer', 'not_contain', 'Alpha'))).toBe(
        "(`sales_invoices`.`customer_id` not in (select `contacts`.`id` from `contacts` where `contacts`.`display_name` like '%Alpha%') or `sales_invoices`.`customer_id` is null)",
      );
    });
  });

  describe('conditions', () => {
    it('combines rows with AND', () => {
      expect(
        whereSql(
          role('invoice_no', 'equal', 'A'),
          role('amount', 'bigger_than', '1', 'and'),
        ),
      ).toBe(
        "((`sales_invoices`.`invoice_no` = 'A') and (COALESCE(`sales_invoices`.`balance`, 0) > 1))",
      );
    });

    it('combines rows with OR', () => {
      expect(
        whereSql(
          role('amount', 'equal', '100'),
          role('amount', 'equal', '500', 'or'),
        ),
      ).toBe(
        '((COALESCE(`sales_invoices`.`balance`, 0) = 100) or (COALESCE(`sales_invoices`.`balance`, 0) = 500))',
      );
    });
  });

  describe('with a sort by a relation', () => {
    it("keeps a computed amount's bare columns off the joined table", () => {
      // Sorting by customer joins contacts, which has a BALANCE column too.
      const dynamicFilter = new DynamicFilter(model);
      dynamicFilter.setFilter(new DynamicFilterSortBy('customer', 'asc'));
      dynamicFilter.setFilter(
        new DynamicFilterAdvancedFilter([
          { ...role('due_amount', 'bigger_than', '0'), index: 1 },
        ]),
      );
      const query = knex('sales_invoices');
      dynamicFilter.buildQuery()(query);

      expect(query.toString()).toBe(
        'select * from `sales_invoices` ' +
          'left join `contacts` as `filter_customer` on `sales_invoices`.`customer_id` = `filter_customer`.`id` ' +
          'where `sales_invoices`.`id` in (select `sales_invoices`.`id` from `sales_invoices` where (TOTAL - PAID) > 0) ' +
          'order by `filter_customer`.`display_name` ASC, `sales_invoices`.`id` ASC',
      );
    });
  });
});
