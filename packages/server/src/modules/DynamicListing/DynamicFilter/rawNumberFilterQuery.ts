import { COMPARATOR_TYPE } from './constants';

const NUMBER_OPERATORS: Record<string, string> = {
  [COMPARATOR_TYPE.EQUAL]: '=',
  [COMPARATOR_TYPE.EQUALS]: '=',
  [COMPARATOR_TYPE.NOT_EQUAL]: '<>',
  [COMPARATOR_TYPE.NOT_EQUALS]: '<>',
  [COMPARATOR_TYPE.BIGGER_THAN]: '>',
  [COMPARATOR_TYPE.BIGGER]: '>',
  [COMPARATOR_TYPE.BIGGER_OR_EQUAL]: '>=',
  [COMPARATOR_TYPE.BIGGER_OR_EQUALS]: '>=',
  [COMPARATOR_TYPE.SMALLER_THAN]: '<',
  [COMPARATOR_TYPE.SMALLER]: '<',
  [COMPARATOR_TYPE.SMALLER_OR_EQUAL]: '<=',
  [COMPARATOR_TYPE.SMALLER_OR_EQUALS]: '<=',
};

/**
 * The SQL operator of a number comparator ("equal" when unknown).
 */
export const numberOperator = (comparator?: string) =>
  NUMBER_OPERATORS[comparator] || '=';

/**
 * A number field's filter query on a SQL expression instead of a column, for
 * amounts that are computed (e.g. an invoice's due amount) or counted.
 * @param {string} sql - The SQL expression to compare.
 */
export const rawNumberFilterQuery =
  (sql: string) => (query, role: { comparator?: string; value: unknown }) => {
    const value = Number(role.value);

    if (role.value === '' || role.value === null || Number.isNaN(value)) {
      query.whereRaw('1 = 0');
      return;
    }
    const operator = numberOperator(role.comparator);
    query.whereRaw(`${sql} ${operator} ?`, [value]);
  };
