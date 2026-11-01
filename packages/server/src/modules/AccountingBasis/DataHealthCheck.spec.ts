import {
  formatDataHealth,
  formatSystemDataHealth,
  IDataHealthResult,
  isDataHealthClean,
  isSystemDataHealthClean,
} from './DataHealthCheck';

const clean = (): IDataHealthResult => ({
  rateOneDocuments: [],
  lockedDocuments: [],
  adjustmentStockLeft: [],
  stockTotalDifferences: [],
  warehousesChecked: false,
  unpostedDecreases: [],
  duplicateNumbers: [],
  blankNumbers: [],
  numberTypesChecked: ['SaleInvoice', 'CreditNote'],
  ownerMemberships: [],
  untaggedLandedCosts: [],
  lotCostDifferences: [],
});

describe('DataHealthCheck output', () => {
  it('prints "none" under every section of a clean company', () => {
    const lines = formatDataHealth(clean(), 'LKR');
    const titles = lines.filter((line) => /^ {2}H\d/.test(line));
    expect(titles).toHaveLength(9);
    expect(lines.filter((line) => line === '      none')).toHaveLength(9);
    expect(lines).toContain(
      '      Unique number index (P3, D5): can be added for all 2 document types',
    );
    expect(isDataHealthClean(clean())).toBe(true);
  });

  it('prints one line per record, as in the plan', () => {
    const result: IDataHealthResult = {
      ...clean(),
      rateOneDocuments: [
        {
          documentType: 'SaleInvoice',
          documentId: 31,
          documentNo: 'INV-00031',
          date: '2026-05-01',
          currencyCode: 'USD',
          amount: 100,
          exchangeRate: 1,
        },
      ],
      stockTotalDifferences: [
        {
          level: 'item',
          itemId: 4,
          itemName: 'Chair',
          warehouseId: null,
          stored: 25,
          fromMovements: 20,
          difference: 5,
        },
      ],
      duplicateNumbers: [
        {
          documentType: 'CreditNote',
          number: 'CN-00010',
          count: 2,
          documentIds: [3, 10],
        },
      ],
    };
    const lines = formatDataHealth(result, 'LKR');
    expect(lines).toContain(
      '      Invoice INV-00031 (#31), 2026-05-01: USD 100.00 at rate 1 (base LKR)',
    );
    expect(lines).toContain(
      '      Item Chair (#4): stock shows 25, movements add up to 20',
    );
    expect(lines).toContain(
      '      Credit note CN-00010 is used by 2 documents (#3, #10)',
    );
    expect(lines).toContain(
      '      Unique number index (P3, D5): can be added for 1 of 2 types; not yet for Credit note',
    );
    expect(isDataHealthClean(result)).toBe(false);

    const many = formatDataHealth(
      {
        ...clean(),
        duplicateNumbers: [
          {
            documentType: 'CreditNote',
            number: '{}',
            count: 12,
            documentIds: Array.from({ length: 12 }, (_v, i) => i + 1),
          },
        ],
      },
      'LKR',
    );
    expect(many).toContain(
      '      Credit note {} is used by 12 documents (#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 and 2 more)',
    );
  });

  it('lists H2 and empty numbers without counting them as problems', () => {
    const result: IDataHealthResult = {
      ...clean(),
      lockedDocuments: [
        {
          documentType: 'SaleInvoice',
          documentId: 44,
          documentNo: 'INV-00044',
          date: '2026-03-15',
          lockedTo: '2026-03-31',
          publishedAt: null,
          publishedAfterLockDate: null,
        },
      ],
      blankNumbers: [{ documentType: 'SaleInvoice', count: 3 }],
    };
    const lines = formatDataHealth(result, 'LKR');
    expect(lines).toContain(
      '      Invoice INV-00044 (#44), 15 Mar 2026, period locked to 31 Mar 2026 (publish time not stored)',
    );
    expect(lines).toContain(
      '      Unique number index (P3, D5): can be added for 1 of 2 types; not yet for Invoice (empty numbers have to be stored as NULL first)',
    );
    expect(isDataHealthClean(result)).toBe(true);
  });

  it('says when H1 or H7 could not run', () => {
    const lines = formatDataHealth(
      { ...clean(), rateOneDocuments: null, ownerMemberships: null },
      '',
    );
    expect(lines).toContain(
      '  H1 Foreign currency documents saved at exchange rate 1: not checked (no base currency)',
    );
    expect(lines).toContain(
      '  H7 Owners who did not create the company: not checked (no system database)',
    );
  });

  it('prints H6 and whether the unique email index can be added', () => {
    expect(formatSystemDataHealth({ duplicateLoginEmails: [] })).toEqual([
      '  H6 Login emails used by more than one login (case ignored): 0',
      '      none',
      '      Unique login email index (S1, D5): can be added',
    ]);
    const shared = {
      duplicateLoginEmails: [
        {
          email: 'priya@example.com',
          users: [
            { id: 7, email: 'priya@example.com', tenantId: 1, deleted: false },
            { id: 9, email: 'Priya@Example.com', tenantId: 2, deleted: true },
          ],
        },
      ],
    };
    expect(formatSystemDataHealth(shared)).toEqual([
      '  H6 Login emails used by more than one login (case ignored): 1',
      '      priya@example.com is used by 2 logins (#7 priya@example.com, #9 Priya@Example.com [deleted])',
      '      Unique login email index (S1, D5): not yet: 1 emails are shared',
    ]);
    expect(isSystemDataHealthClean(shared)).toBe(false);
  });
});
