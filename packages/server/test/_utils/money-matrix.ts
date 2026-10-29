import request = require('supertest');
import { ConfigService } from '@nestjs/config';
import knexFactory, { Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import {
  calcDocumentMoney,
  calcDiscountMoney,
  calcLineMoney,
  multiplyMoney,
  roundMoney,
  subtractMoney,
  sumMoney,
  sumMoneyBy,
} from '@bigcapital/utils';
import { app, orgainzationId } from '../init-app-test';
import { authHeaders } from './gl';

/**
 * The money "same answer" (parity) matrix: the discount values and subtotals
 * that make half cents, and the expected figures from the shared money
 * helpers (the same functions the webapp forms use). Each document of the
 * matrix must give these figures in every place: getter, stored columns,
 * SQL, list tabs, due lists, aging report and ledger.
 */

export interface MatrixDiscount {
  label: string;
  type: 'amount' | 'percentage';
  value: number;
}

export const MATRIX_DISCOUNTS: MatrixDiscount[] = [
  { label: 'amount 3.33', type: 'amount', value: 3.33 },
  { label: '2.5%', type: 'percentage', value: 2.5 },
  { label: '0.5%', type: 'percentage', value: 0.5 },
  { label: '3.33%', type: 'percentage', value: 3.33 },
  { label: '33.33%', type: 'percentage', value: 33.33 },
  { label: '10%', type: 'percentage', value: 10 },
];

export interface MatrixSubtotal {
  label: string;
  quantity: number;
  rate: number;
}

export const MATRIX_SUBTOTALS: MatrixSubtotal[] = [
  { label: '101.00', quantity: 1, rate: 101 },
  { label: '1.00', quantity: 1, rate: 1 },
  { label: '33.33', quantity: 1, rate: 33.33 },
  { label: '3 x 33.33', quantity: 3, rate: 33.33 },
  { label: '1.5 x 33.33', quantity: 1.5, rate: 33.33 },
  { label: '999.99', quantity: 1, rate: 999.99 },
];

export type MatrixLevel = 'line' | 'document';
export type MatrixTax = 'none' | 'exclusive' | 'inclusive';

/** Rate of the foreign currency documents (the e2e org base is USD). */
export const FOREIGN_CURRENCY = 'EUR';
export const FOREIGN_RATE = 1.2345678;
export const TAX_RATE = 15;
export const ADJUSTMENT = 1.11;

export interface MatrixCase {
  name: string;
  discount: MatrixDiscount;
  subtotal: MatrixSubtotal;
  level: MatrixLevel;
  tax: MatrixTax;
  adjustment: number;
  foreign: boolean;
  /** Two payments (a part, then the rest) or one full payment. */
  twoPayments: boolean;
}

/**
 * Every discount x subtotal x level. The 12 combinations of tax (3) x
 * adjustment (2) x currency (2) are cycled over the cases, so each one is
 * met by line and document discounts alike (the full cross of all
 * combinations runs on the formulas in money-parity-sql.e2e-spec.ts).
 * Cases whose fixed discount is bigger than the subtotal are left out:
 * they are rejected as a negative line or total.
 */
export const buildMatrix = (withTax: boolean): MatrixCase[] => {
  const combos: Array<[MatrixTax, number, boolean]> = [];
  (withTax
    ? (['none', 'exclusive', 'inclusive'] as MatrixTax[])
    : ['none']
  ).forEach((tax: MatrixTax) =>
    [0, ADJUSTMENT].forEach((adjustment) =>
      [false, true].forEach((foreign) =>
        combos.push([tax, adjustment, foreign]),
      ),
    ),
  );
  const cases: MatrixCase[] = [];

  MATRIX_DISCOUNTS.forEach((discount, d) =>
    MATRIX_SUBTOTALS.forEach((subtotal, s) =>
      (['line', 'document'] as MatrixLevel[]).forEach((level, l) => {
        // Each discount meets all the combinations over its subtotals (6 for
        // line and the other 6 for document discounts, shifted per
        // discount), so line and document discounts alike meet every tax,
        // adjustment and currency.
        const [tax, adjustment, foreign] =
          combos[(s + 6 * l + d) % combos.length];
        const twoPayments = (d + s + l) % 3 !== 1;

        if (
          discount.type === 'amount' &&
          discount.value > subtotal.quantity * subtotal.rate
        ) {
          return;
        }
        cases.push({
          name: [
            `${level} discount ${discount.label}`,
            `on ${subtotal.label}`,
            `tax ${tax}`,
            adjustment ? `adjustment ${adjustment}` : 'no adjustment',
            foreign ? FOREIGN_CURRENCY : 'base currency',
            twoPayments ? 'paid in 2 parts' : 'paid in full',
          ].join(', '),
          discount,
          subtotal,
          level,
          tax,
          adjustment,
          foreign,
          twoPayments,
        });
      }),
    ),
  );
  return cases;
};

export interface MatrixExpected {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
  /** The total in the base currency, as the ledger posts it. */
  totalLocal: number;
  rate: number;
}

/** The entry lines of a case, as the API takes them. */
export const caseEntries = (
  matrixCase: MatrixCase,
  itemId: number,
  taxRateId?: number,
) => [
  {
    index: 1,
    itemId,
    quantity: matrixCase.subtotal.quantity,
    rate: matrixCase.subtotal.rate,
    ...(matrixCase.level === 'line' && {
      discount: matrixCase.discount.value,
      discountType: matrixCase.discount.type,
    }),
    ...(matrixCase.tax !== 'none' && taxRateId && { taxRateId }),
  },
];

/** The document discount fields of a case, as the API takes them. */
export const caseDocumentFields = (matrixCase: MatrixCase) => ({
  ...(matrixCase.level === 'document' && {
    discount: matrixCase.discount.value,
    discountType: matrixCase.discount.type,
  }),
  ...(matrixCase.adjustment && { adjustment: matrixCase.adjustment }),
  ...(matrixCase.tax !== 'none' && {
    isInclusiveTax: matrixCase.tax === 'inclusive',
  }),
  exchangeRate: matrixCase.foreign ? FOREIGN_RATE : 1,
});

/**
 * The expected figures of a case, from the shared money helpers only:
 * calcLineMoney per line (what the webapp entries table shows) and
 * calcDocumentMoney for the document (what the webapp form footer shows).
 */
export const expectedOf = (matrixCase: MatrixCase): MatrixExpected => {
  const lines = [
    calcLineMoney({
      quantity: matrixCase.subtotal.quantity,
      rate: matrixCase.subtotal.rate,
      discount: matrixCase.level === 'line' ? matrixCase.discount.value : 0,
      discountType: matrixCase.discount.type,
      taxRate: matrixCase.tax === 'none' ? 0 : TAX_RATE,
      isInclusiveTax: matrixCase.tax === 'inclusive',
    }),
  ];
  const subtotal = sumMoneyBy(lines, 'taxableAmount');
  const taxAmount = sumMoneyBy(lines, 'taxAmount');
  const doc = calcDocumentMoney({
    subtotal,
    discount: matrixCase.level === 'document' ? matrixCase.discount.value : 0,
    discountType: matrixCase.discount.type,
    adjustment: matrixCase.adjustment,
    taxAmountWithheld: taxAmount,
    isInclusiveTax: matrixCase.tax === 'inclusive',
  });
  const rate = matrixCase.foreign ? FOREIGN_RATE : 1;

  return {
    subtotal,
    taxAmount,
    discountAmount: doc.discountAmount,
    total: doc.total,
    totalLocal: multiplyMoney(doc.total, rate),
    rate,
  };
};

/**
 * The figures the webapp form shows for a case, computed its way, step by
 * step (the webapp has no unit test runner, so its formula is replayed
 * here; keep it in step with):
 * - line amount: calcItemEntryTotal (containers/Entries/utils.tsx) =
 *   calcLineMoney(quantity, rate, discount).taxableAmount,
 * - line tax: getInclusiveTaxAmount / getExlusiveTaxAmount on that amount,
 * - discount: calcDiscountMoney(subtotal, discount, discountType),
 * - total: sumMoney(subtotal, adjustment, -discount, exclusive tax)
 *   (useInvoiceTotal / useBillTotal ...).
 */
export const webappFiguresOf = (matrixCase: MatrixCase) => {
  const amount = calcLineMoney({
    quantity: matrixCase.subtotal.quantity,
    rate: matrixCase.subtotal.rate,
    discount: matrixCase.level === 'line' ? matrixCase.discount.value : 0,
    discountType: matrixCase.discount.type,
  }).taxableAmount;
  const taxAmount =
    matrixCase.tax === 'none'
      ? 0
      : calcLineMoney({
          quantity: 1,
          rate: amount,
          taxRate: TAX_RATE,
          isInclusiveTax: matrixCase.tax === 'inclusive',
        }).taxAmount;
  const subtotal = sumMoney(amount);
  const discountAmount = calcDiscountMoney(
    subtotal,
    matrixCase.level === 'document' ? matrixCase.discount.value : 0,
    matrixCase.discount.type,
  );
  return {
    subtotal,
    taxAmount,
    discountAmount,
    total: sumMoney(
      subtotal,
      matrixCase.adjustment,
      -discountAmount,
      matrixCase.tax === 'exclusive' ? taxAmount : 0,
    ),
  };
};

/** The first payment of a two-part payment: a third, at least a cent. */
export const firstPartOf = (total: number) =>
  Math.max(roundMoney(total / 3), 0.01);

export const restOf = (total: number, paid: number) =>
  subtractMoney(total, paid);

/** Reads a field from an API body in camelCase or snake_case. */
export const field = (body: any, camelKey: string): any => {
  if (!body) return undefined;
  if (body[camelKey] !== undefined) return body[camelKey];
  const snake = camelKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return body[snake];
};

export const num = (body: any, camelKey: string): number =>
  Number(field(body, camelKey) ?? 0);

let tenantKnex: Knex | null = null;

/**
 * A direct connection to the e2e tenant database, to read the stored
 * columns and run the model SQL. Read-only use.
 */
export const getTenantKnex = (): Knex => {
  if (tenantKnex) return tenantKnex;
  const config = app.get(ConfigService).get('tenantDatabase');

  tenantKnex = knexFactory({
    client: config.client,
    connection: {
      host: config.host,
      port: Number(config.port),
      user: config.user,
      password: config.password,
      database: `${config.dbNamePrefix}${orgainzationId}`,
      charset: 'utf8',
    },
    pool: { min: 0, max: 2 },
    // As the app's tenant connection (the health check relies on it).
    ...knexSnakeCaseMappers({ upperCase: true }),
  });
  return tenantKnex;
};

export const closeTenantKnex = async () => {
  if (tenantKnex) await tenantKnex.destroy();
  tenantKnex = null;
};

/** Selects money SQL expressions for one row of a table. */
export const selectMoneySql = async (
  table: string,
  id: number,
  expressions: Record<string, string>,
): Promise<Record<string, number>> => {
  const knex = getTenantKnex();
  const columns = Object.entries(expressions)
    .map(([key, sql]) => `${sql} AS \`${key}\``)
    .join(', ');
  const [rows] = await knex.raw(
    `SELECT ${columns} FROM ${table} WHERE ID = ?`,
    [id],
  );
  const row = rows[0];
  return Object.fromEntries(
    Object.keys(expressions).map((key) => [key, Number(row[key])]),
  );
};

/** Reads stored columns of one row (aliased, so the key mapper leaves them). */
export const selectColumns = async (
  table: string,
  id: number,
  columns: string[],
): Promise<Record<string, number>> => {
  const knex = getTenantKnex();
  const [rows] = await knex.raw(
    `SELECT ${columns.map((column, i) => `${column} AS v${i}`).join(', ')} FROM ${table} WHERE ID = ?`,
    [id],
  );
  return Object.fromEntries(
    columns.map((column, i) => [column, Number(rows[0][`v${i}`] ?? 0)]),
  );
};

/** Creates a customer or vendor of its own for one case. */
export const createContact = async (
  kind: 'customers' | 'vendors',
  currencyCode: string,
  name: string,
) => {
  const res = await request(app.getHttpServer())
    .post(`/${kind}`)
    .set(authHeaders())
    .send({
      displayName: name,
      email: `${name.replace(/[^a-z0-9]/gi, '').slice(0, 30)}@example.com`,
      currencyCode,
      ...(kind === 'customers' ? { customerType: 'business' } : {}),
    })
    .expect(201);
  return res.body.id as number;
};

/** The rows of a list response, whatever its key. */
export const rowsOf = (body: any): any[] => {
  if (Array.isArray(body)) return body;
  const found = Object.values(body || {}).find((value) => Array.isArray(value));
  return (found as any[]) || [];
};

/** The ids a list endpoint returns with a status filter. */
export const listIdsByStatus = async (
  path: string,
  status: string,
  keyword: string,
) => {
  const res = await request(app.getHttpServer())
    .get(path)
    .query({
      searchKeyword: keyword,
      stringifiedFilterRoles: JSON.stringify([
        { index: 1, fieldKey: 'status', comparator: 'equals', value: status },
      ]),
    })
    .set(authHeaders())
    .expect(200);
  return rowsOf(res.body).map((row) => row.id);
};

/**
 * The due amount (base currency) the aging summary shows for one contact:
 * the report total (current + aging periods) filtered to that contact.
 */
export const agingTotalOf = async (
  path: string,
  contactId: number,
  asDate: string,
) => {
  const idsKey = path.includes('receivable') ? 'customersIds' : 'vendorsIds';
  const res = await request(app.getHttpServer())
    .get(path)
    .query(
      `asDate=${asDate}&agingDaysBefore=30&agingPeriods=3&${idsKey}[]=${contactId}`,
    )
    .set(authHeaders())
    .expect(200);
  const data = res.body.data ?? res.body;
  const total = field(data, 'total');
  const amount = field(total, 'total');
  return Number(amount?.amount ?? amount ?? 0);
};
