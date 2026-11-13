import knexFactory from 'knex';
import { DynamicFilter } from './DynamicFilter';
import { DynamicFilterSortBy } from './DynamicFilterSortBy';

const knex = knexFactory({ client: 'mysql2' });

const makeModel = (fields: Record<string, any>) =>
  ({
    tableName: 'payment_receives',
    relationMappings: {},
    getField: (key: string) => fields[key],
  }) as any;

const buildSql = (sortBy: DynamicFilterSortBy) => {
  const query = knex('payment_receives');
  sortBy.buildQuery()(query);
  return query.toString();
};

describe('DynamicFilterSortBy', () => {
  it('breaks ties on the sort column by id, in the same direction', () => {
    const sortBy = new DynamicFilterSortBy('created_at', 'desc');
    sortBy.setModel(
      makeModel({ created_at: { column: 'created_at', fieldType: 'date' } }),
    );

    expect(buildSql(sortBy)).toBe(
      'select * from `payment_receives` order by `payment_receives`.`created_at` DESC, `payment_receives`.`id` DESC',
    );
  });

  it('adds the id tie-breaker after a custom sort query', () => {
    const sortBy = new DynamicFilterSortBy('amount', 'asc');
    sortBy.setModel(
      makeModel({
        amount: {
          column: 'amount',
          fieldType: 'number',
          sortCustomQuery: (builder, { order }) =>
            builder.orderByRaw(`amount ${order}`),
        },
      }),
    );

    expect(buildSql(sortBy)).toBe(
      'select * from `payment_receives` order by amount ASC, `payment_receives`.`id` ASC',
    );
  });

  it('sorts a relation field by its label on the aliased join', () => {
    const model = {
      tableName: 'payment_receives',
      relationMappings: {
        customer: {
          modelClass: {
            getField: (key: string, attr: string) =>
              key === 'display_name' && attr === 'column'
                ? 'display_name'
                : undefined,
          },
          join: { from: 'payment_receives.customer_id', to: 'contacts.id' },
        },
      },
      getField: (key: string) =>
        ({
          customer: {
            column: 'customer_id',
            fieldType: 'relation',
            relationKey: 'customer',
            relationEntityLabel: 'display_name',
            relationEntityKey: 'id',
          },
        })[key],
    } as any;
    const dynamicFilter = new DynamicFilter(model);
    dynamicFilter.setFilter(new DynamicFilterSortBy('customer', 'asc'));

    const query = knex('payment_receives');
    dynamicFilter.buildQuery()(query);

    expect(query.toString()).toBe(
      'select * from `payment_receives` left join `contacts` as `filter_customer` on `payment_receives`.`customer_id` = `filter_customer`.`id` order by `filter_customer`.`display_name` ASC, `payment_receives`.`id` ASC',
    );
  });
});
