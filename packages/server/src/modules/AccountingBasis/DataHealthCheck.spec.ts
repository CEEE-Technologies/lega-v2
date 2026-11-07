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
  landedCostsWithoutCashSet: [],
  lotCostDifferences: [],
  membershipsWithoutUser: [],
  orphanWriteOffs: [],
  landedCostSourcesGone: [],
  landedCostLinesOverAllocated: [],
  landedCostsFromInventoryLines: [],
  bankLinesToMissingRecords: [],
  possibleDoubleCounts: [],
  accountingBasis: 'accrual',
  ledgerMismatches: [],
  taxRowDifferences: [],
  matchedRateOnePayments: [],
  duplicateStockRows: [],
});

describe('DataHealthCheck output', () => {
  it('prints "none" under every section of a clean company', () => {
    const lines = formatDataHealth(clean(), 'LKR');
    const titles = lines.filter((line) => /^ {2}H\d/.test(line));
    // H1–H8: 10 sections; H9–H16: 11 sections.
    expect(titles).toHaveLength(21);
    expect(lines.filter((line) => line === '      none')).toHaveLength(21);
    expect(lines).toContain(
      '      Q3 migration (one stock row per item and warehouse): nothing to merge',
    );
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

  it('prints the round 3 sections (H9–H16) one line per record, as in the plan', () => {
    const result: IDataHealthResult = {
      ...clean(),
      membershipsWithoutUser: [
        { userId: 12, email: 'sock@evil', role: 'admin', loginDeleted: false },
      ],
      orphanWriteOffs: [
        {
          invoiceId: 312,
          customerName: 'Acme',
          date: '2026-05-01',
          amount: 1000,
          rows: 2,
        },
      ],
      landedCostSourcesGone: [
        {
          landedCostId: 18,
          amount: 200,
          currencyCode: 'LKR',
          fromType: 'Expense',
          fromId: 77,
          fromNo: null,
          fromEntryId: 90,
          missing: 'document',
          billId: 5,
          billNo: 'B-00005',
        },
      ],
      landedCostLinesOverAllocated: [
        {
          fromType: 'Bill',
          fromId: 7,
          fromNo: 'B-00007',
          fromEntryId: 31,
          lineAmount: 50,
          allocated: 200,
          landedCostIds: [19],
        },
      ],
      landedCostsFromInventoryLines: [
        {
          landedCostId: 20,
          amount: 30,
          fromBillId: 8,
          fromBillNo: 'B-00008',
          fromEntryId: 40,
          itemId: 3,
          itemName: 'Chair',
          billId: 9,
          billNo: 'B-00009',
        },
      ],
      bankLinesToMissingRecords: [
        {
          lineId: 25,
          date: '2026-02-25',
          amount: 500,
          accountId: 2,
          accountName: 'Bank',
          link: 'categorized',
          referenceType: 'CashflowTransaction',
          referenceId: 90,
          unknownType: false,
        },
      ],
      possibleDoubleCounts: [
        {
          lineId: 26,
          date: '2026-02-26',
          amount: 300,
          accountId: 2,
          accountName: 'Bank',
          lineUse: 'categorized to Bank transaction #91',
          paymentType: 'PaymentReceive',
          paymentId: 4,
          paymentNo: 'PR-00001',
        },
      ],
      ledgerMismatches: [
        {
          documentType: 'SaleInvoice',
          documentId: 412,
          documentNo: 'INV-00412',
          date: '2026-05-02',
          currencyCode: 'LKR',
          total: 1000,
          expected: 1000,
          ledger: null,
          problem: 'no_entries',
        },
        {
          documentType: 'Bill',
          documentId: 413,
          documentNo: 'B-00413',
          date: '2026-05-02',
          currencyCode: 'USD',
          total: 10,
          expected: 3000,
          ledger: 2990,
          problem: 'different',
        },
      ],
      taxRowDifferences: [
        {
          documentType: 'SaleInvoice',
          documentId: 388,
          documentNo: 'INV-00388',
          draft: false,
          taxAmount: 150,
          lineRateIds: [1],
          rowRateIds: [],
        },
      ],
      matchedRateOnePayments: [
        {
          paymentType: 'PaymentReceive',
          paymentId: 51,
          paymentNo: 'PAY-00051',
          date: '2026-05-03',
          currencyCode: 'EUR',
          amount: 1000,
          exchangeRate: 1,
          lineIds: [27],
        },
      ],
      duplicateStockRows: [
        {
          itemId: 3,
          itemName: 'Chair',
          warehouseId: 1,
          warehouseName: 'Main',
          quantities: [5, 5],
          merged: 10,
          fromMovements: 5,
        },
      ],
    };
    const lines = formatDataHealth(result, 'LKR');
    [
      '      sock@evil (login #12) is a member (admin) but not a user here',
      '      Write-off of 1,000.00 for deleted invoice #312 (customer Acme), 2026-05-01: 2 ledger rows',
      '      Landed cost #18: LKR 200.00 onto bill B-00005 (#5) from expense #77, which no longer exists',
      '      Bill B-00007 (#7) line #31: line 50.00 (after discount, before tax), 200.00 allocated by landed cost #19',
      '      Landed cost #20: 30.00 from bill B-00008 (#8) line #40, inventory item Chair (#3), onto bill B-00009 (#9)',
      '      Bank line #25, 2026-02-25, 500.00 in Bank (#2): categorized to bank transaction #90, which no longer exists',
      '      Bank line #26, 2026-02-26, 300.00 in Bank (#2) (categorized to Bank transaction #91) and payment received PR-00001 (#4)',
      '      Invoice INV-00412 (#412), 2026-05-02, 1,000.00: no ledger entries',
      '      Bill B-00413 (#413), 2026-05-02, USD 10.00 = 3,000.00 LKR: entries put 2,990.00 on its account',
      '      Invoice INV-00388 (#388): tax 150.00, lines use rates #1, tax rows 0',
      '      Payment received PAY-00051 (#51), 2026-05-03: EUR 1,000.00 at rate 1 (base LKR), matched to bank line #27',
      '      Item Chair (#3) / warehouse Main (#1): 2 rows (5, 5); the Q3 migration would store 10, the stock movements add up to 5 (check after merging: H3)',
      '      Q3 migration (one stock row per item and warehouse): would merge 2 rows into 1 (1 items), summing their quantities',
    ].forEach((line) => expect(lines).toContain(line));
    expect(isDataHealthClean(result)).toBe(false);

    // The H12 list of possible double counts alone isn't a problem.
    expect(
      isDataHealthClean({
        ...clean(),
        possibleDoubleCounts: result.possibleDoubleCounts,
      }),
    ).toBe(true);
    // Each other new list is.
    (
      [
        'membershipsWithoutUser',
        'orphanWriteOffs',
        'landedCostSourcesGone',
        'landedCostLinesOverAllocated',
        'landedCostsFromInventoryLines',
        'bankLinesToMissingRecords',
        'ledgerMismatches',
        'taxRowDifferences',
        'matchedRateOnePayments',
        'duplicateStockRows',
      ] as const
    ).forEach((key) =>
      expect(isDataHealthClean({ ...clean(), [key]: result[key] } as any)).toBe(
        false,
      ),
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

  it('says when H1, H7, H9, H14 or H15 could not run', () => {
    const lines = formatDataHealth(
      {
        ...clean(),
        rateOneDocuments: null,
        ownerMemberships: null,
        membershipsWithoutUser: null,
        taxRowDifferences: null,
        matchedRateOnePayments: null,
      },
      '',
    );
    expect(lines).toContain(
      '  H9 Members with no user record in the company: not checked (no system database)',
    );
    expect(lines).toContain(
      '  H14 Invoices and bills whose tax rows do not match their taxed lines: not checked (sales tax is off)',
    );
    expect(lines).toContain(
      '  H15 Payments made by bank matching for a foreign document at rate 1: not checked (no base currency)',
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
