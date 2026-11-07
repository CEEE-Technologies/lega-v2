import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { Company, createCompany, systemKnex } from './_utils/security';
import {
  checkDataHealth,
  formatDataHealth,
  IDataHealthResult,
  isDataHealthClean,
} from '../src/modules/AccountingBasis/DataHealthCheck';
import { isRound3DataHealthClean } from '../src/modules/AccountingBasis/DataHealthCheckRound3';

/**
 * Round 3 data health check (H9–H16, Package 5). A new company is built and
 * checked clean ("none" in every new section), then one bad record of each
 * kind is written straight into its database (the fixed code no longer
 * makes them) and each is checked to be listed. The check runs on
 * connections set to read only, so any write it tried would fail.
 */
// Each test adds to the same company, so a retry would add twice.
jest.retryTimes(0);

const STOCK_INDEX = 'items_warehouses_quantity_item_id_warehouse_id_unique';

describe('Data health check, round 3 (H9–H16)', () => {
  let company: Company;
  let db: Knex; // Writable: the test's own bad records.
  let readOnlyDb: Knex; // What the check reads through.
  let readOnlySystemDb: Knex;
  let sys: Knex;
  const tag = faker.string.alphanumeric(6).toLowerCase();
  const systemUserIds: number[] = [];

  const connect = (database: string, readOnly: boolean) => {
    const config = app.get(ConfigService).get('tenantDatabase');
    return knexFactory({
      client: config.client,
      connection: {
        host: config.host,
        port: Number(config.port),
        user: config.user,
        password: config.password,
        database,
        charset: 'utf8',
        dateStrings: ['DATE'] as unknown as boolean,
      },
      pool: {
        min: 0,
        max: 1,
        ...(readOnly && {
          afterCreate: (conn: any, done: (err: any, conn: any) => void) =>
            conn.query('SET SESSION TRANSACTION READ ONLY', (err: any) =>
              done(err, conn),
            ),
        }),
      },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
  };

  const run = () =>
    checkDataHealth(readOnlyDb, 'USD', {
      systemKnex: readOnlySystemDb,
      tenantId: company.tenantId,
    });

  /** The printed lines of the section whose title starts with `title`. */
  const sectionLines = (result: IDataHealthResult, title: string) => {
    const lines = formatDataHealth(result, 'USD');
    const start = lines.findIndex((line) => line.startsWith(`  ${title}`));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('  H'));
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
  };

  let accounts: {
    bank: number;
    receivable: number;
    payable: number;
    income: number;
    inventory: number;
    cost: number;
  };
  const insert = async (table: string, row: Record<string, any>) =>
    (await db(table).insert(row))[0] as number;

  const contact = (contactService: 'customer' | 'vendor', currency = 'USD') =>
    insert('contacts', {
      contactService,
      contactType: 'business',
      displayName: `HC3 ${contactService} ${currency} ${tag}`,
      currencyCode: currency,
      active: 1,
      balance: 0,
    });
  const item = (name: string, type = 'inventory') =>
    insert('items', {
      name: `${name} ${tag}`,
      type,
      sellable: 1,
      purchasable: 1,
      quantityOnHand: 0,
      costAccountId: accounts.cost,
      sellAccountId: accounts.income,
      inventoryAccountId: accounts.inventory,
      active: 1,
    });
  /** A balanced ledger set: [accountId, debit, credit] rows. */
  const post = async (
    referenceType: string,
    referenceId: number,
    rows: Array<[number, number, number]>,
    extra: Record<string, any> = {},
  ) => {
    for (const [accountId, debit, credit] of rows) {
      await insert('accounts_transactions', {
        referenceType,
        referenceId,
        accountId,
        debit,
        credit,
        date: '2026-06-01',
        currencyCode: 'USD',
        exchangeRate: 1,
        ...extra,
      });
    }
  };
  /** A bill; a draft unless `published` (a draft needs no entries). */
  const bill = async (
    billNumber: string,
    amount: number,
    published = false,
  ) => {
    const vendorId = await contact('vendor');
    return insert('bills', {
      vendorId,
      billNumber: `${billNumber}-${tag}`,
      billDate: '2026-06-01',
      dueDate: '2026-06-30',
      amount,
      currencyCode: 'USD',
      exchangeRate: 1,
      openedAt: published ? '2026-06-01 10:00:00' : null,
    });
  };
  const billLine = (billId: number, itemId: number, row: Record<string, any>) =>
    insert('items_entries', {
      referenceType: 'Bill',
      referenceId: billId,
      index: 1,
      itemId,
      ...row,
    });
  const landedCost = (row: Record<string, any>) =>
    insert('bill_located_costs', {
      currencyCode: 'USD',
      exchangeRate: 1,
      allocationMethod: 'value',
      costAccountId: accounts.cost,
      ...row,
    });
  const bankLine = (amount: number, row: Record<string, any> = {}) =>
    insert('uncategorized_cashflow_transactions', {
      date: '2026-06-02',
      amount,
      currencyCode: 'USD',
      accountId: accounts.bank,
      description: `HC3 ${tag}`,
      ...row,
    });

  beforeAll(async () => {
    company = await createCompany(app, 'hc3');
    const prefix = app.get(ConfigService).get('tenantDatabase.dbNamePrefix');
    db = connect(`${prefix}${company.organizationId}`, false);
    readOnlyDb = connect(`${prefix}${company.organizationId}`, true);
    sys = systemKnex(app);
    const systemDatabase = app
      .get(ConfigService)
      .get('systemDatabase.databaseName');
    readOnlySystemDb = connect(systemDatabase, true);

    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      bank: await byType('bank'),
      receivable: await byType('accounts-receivable'),
      payable: await byType('accounts-payable'),
      income: await byType('income'),
      inventory: await byType('inventory'),
      cost: await byType('cost-of-goods-sold'),
    };
  });

  afterAll(async () => {
    if (systemUserIds.length) {
      await sys('user_tenants').whereIn('userId', systemUserIds).delete();
      await sys('users').whereIn('id', systemUserIds).delete();
    }
    await Promise.all(
      [db, readOnlyDb, readOnlySystemDb]
        .filter(Boolean)
        .map((k) => k.destroy()),
    );
  });

  it('runs on read-only connections (a write there fails)', async () => {
    await expect(
      readOnlyDb('settings').insert({ group: 'hc3', key: 'hc3', value: '1' }),
    ).rejects.toThrow(/read.only/i);
  });

  it('a clean company prints "none" in every new section', async () => {
    const result = await run();
    expect(isRound3DataHealthClean(result)).toBe(true);
    expect(isDataHealthClean(result)).toBe(true);
    expect(result.possibleDoubleCounts).toEqual([]);

    const lines = formatDataHealth(result, 'USD');
    const titles = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^ {2}H(9|1\d) /.test(line));
    expect(titles.map(({ line }) => line.slice(2, 5).trim())).toEqual([
      'H9',
      'H10',
      'H11',
      'H11',
      'H11',
      'H12',
      'H12',
      'H13',
      'H14',
      'H15',
      'H16',
    ]);
    titles.forEach(({ line, index }) => {
      expect(line).toMatch(/: 0$/);
      // The H12 "may be counted twice" list prints its note first.
      const next = lines[index + (line.includes('counted twice') ? 2 : 1)];
      expect(next).toBe('      none');
    });
    expect(lines).toContain(
      '      Q3 migration (one stock row per item and warehouse): nothing to merge',
    );
    expect(lines.join('\n')).toContain('company reports on the accrual basis');
  });

  it('H9 lists a member with no user record in the company (S6)', async () => {
    const email = `hc3-member-${tag}@example.com`;
    const [userId] = await sys('users').insert({
      firstName: 'HC3',
      email,
      active: 1,
      createdAt: new Date(),
    });
    systemUserIds.push(userId);
    // As the old invite did: a membership in this company, no user here.
    await sys('user_tenants').insert({
      userId,
      tenantId: company.tenantId,
      role: 'admin',
      createdAt: new Date(),
    });
    const result = await run();
    expect(result.membershipsWithoutUser).toEqual([
      { userId, email, role: 'admin', loginDeleted: false },
    ]);
    expect(sectionLines(result, 'H9')).toEqual([
      '  H9 Members with no user record in the company (not on the Users page, so they cannot be removed there): 1',
      `      ${email} (login #${userId}) is a member (admin) but not a user here`,
    ]);
    // The owner (a user of the company) isn't listed.
    expect(
      result.membershipsWithoutUser?.map((row) => row.userId),
    ).not.toContain(company.owner.systemUserId);
  });

  it('H10 lists a write-off whose invoice no longer exists (B1)', async () => {
    const customerId = await contact('customer');
    // A write-off of an invoice that still exists isn't listed.
    const invoiceId = await insert('sales_invoices', {
      customerId,
      invoiceNo: `HC3-WO-${tag}`,
      invoiceDate: '2026-06-01',
      dueDate: '2026-06-30',
      balance: 300,
      currencyCode: 'USD',
      exchangeRate: 1,
      deliveredAt: '2026-06-01',
      writtenoffAmount: 300,
      writtenoffAt: '2026-06-03',
    });
    await post('SaleInvoice', invoiceId, [
      [accounts.receivable, 300, 0],
      [accounts.income, 0, 300],
    ]);
    const writeOff = (referenceId: number, amount: number) =>
      post(
        'InvoiceWriteOff',
        referenceId,
        [
          [accounts.cost, amount, 0],
          [accounts.receivable, 0, amount],
        ],
        { contactId: customerId, basis: 'accrual' },
      );
    await writeOff(invoiceId, 300);
    await writeOff(987312, 1000);

    const result = await run();
    expect(sectionLines(result, 'H10')).toEqual([
      '  H10 Write-off entries whose invoice no longer exists: 1',
      `      Write-off of 1,000.00 for deleted invoice #987312 (customer HC3 customer USD ${tag}), 2026-06-01: 2 ledger rows`,
    ]);
  });

  it('H11 lists landed costs whose source is gone, over-allocated or an inventory line (B2, Q9)', async () => {
    const goods = await bill('HC3-GDS', 1000);
    const freightItem = await item('HC3 Freight', 'service');
    const stockItem = await item('HC3 Stock');

    // (a) The source expense is gone.
    const goneExpense = await landedCost({
      amount: 200,
      fromTransactionType: 'Expense',
      fromTransactionId: 987077,
      fromTransactionEntryId: 987078,
      billId: goods,
    });
    // (a) The expense is there, its line was re-written with a new id.
    const expenseId = await insert('expenses_transactions', {
      totalAmount: 150,
      currencyCode: 'USD',
      exchangeRate: 1,
      referenceNo: `HC3-EXP-${tag}`,
      paymentAccountId: accounts.bank,
      paymentDate: '2026-06-01',
    });
    await insert('expense_transaction_categories', {
      expenseId,
      expenseAccountId: accounts.cost,
      index: 1,
      amount: 150,
      allocatedCostAmount: 0,
      landedCost: 1,
    });
    const goneLine = await landedCost({
      amount: 150,
      fromTransactionType: 'Expense',
      fromTransactionId: expenseId,
      fromTransactionEntryId: 987079,
      billId: goods,
    });
    // (b) A 50 freight line with 80 allocated from it (and a fine one).
    const freight = await bill('HC3-FRT', 100);
    const smallLine = await billLine(freight, freightItem, {
      quantity: 1,
      rate: 50,
      landedCost: 1,
    });
    const fineLine = await billLine(freight, freightItem, {
      index: 2,
      quantity: 1,
      rate: 50,
      landedCost: 1,
    });
    const over1 = await landedCost({
      amount: 50,
      fromTransactionType: 'Bill',
      fromTransactionId: freight,
      fromTransactionEntryId: smallLine,
      billId: goods,
    });
    const over2 = await landedCost({
      amount: 30,
      fromTransactionType: 'Bill',
      fromTransactionId: freight,
      fromTransactionEntryId: smallLine,
      billId: goods,
    });
    await landedCost({
      amount: 50,
      fromTransactionType: 'Bill',
      fromTransactionId: freight,
      fromTransactionEntryId: fineLine,
      billId: goods,
    });
    // (c) Landed cost taken from an inventory line (before Q9).
    const stockBill = await bill('HC3-STK', 40);
    const stockLine = await billLine(stockBill, stockItem, {
      quantity: 2,
      rate: 20,
    });
    const fromStock = await landedCost({
      amount: 40,
      fromTransactionType: 'Bill',
      fromTransactionId: stockBill,
      fromTransactionEntryId: stockLine,
      billId: goods,
    });

    const result = await run();
    expect(sectionLines(result, 'H11 Landed costs whose source')).toEqual([
      '  H11 Landed costs whose source expense or bill (or its line) no longer exists: 2',
      `      Landed cost #${goneExpense}: USD 200.00 onto bill HC3-GDS-${tag} (#${goods}) from expense #987077, which no longer exists`,
      `      Landed cost #${goneLine}: USD 150.00 onto bill HC3-GDS-${tag} (#${goods}) from expense HC3-EXP-${tag} (#${expenseId}) line #987079, which no longer exists (the expense is still there)`,
    ]);
    expect(sectionLines(result, 'H11 Source lines')).toEqual([
      '  H11 Source lines with more landed cost allocated than the line: 1',
      `      Bill HC3-FRT-${tag} (#${freight}) line #${smallLine}: line 50.00 (after discount, before tax), 80.00 allocated by landed cost #${over1}, #${over2}`,
    ]);
    expect(sectionLines(result, 'H11 Landed costs taken')).toEqual([
      '  H11 Landed costs taken from an inventory bill line (that cost went into stock twice): 1',
      `      Landed cost #${fromStock}: 40.00 from bill HC3-STK-${tag} (#${stockBill}) line #${stockLine}, inventory item HC3 Stock ${tag} (#${stockItem}), onto bill HC3-GDS-${tag} (#${goods})`,
    ]);
  });

  it('H12 lists bank lines linked to records that are gone, and possible double counts (B3, B4)', async () => {
    // Categorized to a deposit that was deleted.
    const categorized = await bankLine(500, {
      categorizeRefType: 'CashflowTransaction',
      categorizeRefId: 987090,
      categorized: 1,
    });
    // Matched to an expense that was deleted.
    const matched = await bankLine(-75);
    await insert('matched_bank_transactions', {
      uncategorizedTransactionId: matched,
      referenceType: 'Expense',
      referenceId: 987091,
      amount: 75,
    });
    // B4: a line categorized to income (an existing, unpublished bank
    // transaction) and a 300 payment on the same day and account that no
    // line is matched to, left by an unmatch.
    const deposit = await insert('cashflow_transactions', {
      transactionType: 'other_income',
      date: '2026-06-02',
      amount: 300,
      currencyCode: 'USD',
      exchangeRate: 1,
      cashflowAccountId: accounts.bank,
      creditAccountId: accounts.income,
      transactionNumber: `HC3-DEP-${tag}`,
    });
    const reused = await bankLine(300, {
      categorizeRefType: 'CashflowTransaction',
      categorizeRefId: deposit,
      categorized: 1,
    });
    const customerId = await contact('customer');
    const leftover = await insert('payment_receives', {
      customerId,
      paymentDate: '2026-06-02',
      amount: 300,
      paymentReceiveNo: `HC3-PAY-${tag}`,
      depositAccountId: accounts.bank,
      currencyCode: 'USD',
      exchangeRate: 1,
    });
    await post('PaymentReceive', leftover, [
      [accounts.bank, 300, 0],
      [accounts.receivable, 0, 300],
    ]);

    const result = await run();
    expect(sectionLines(result, 'H12 Bank lines categorized')).toEqual([
      '  H12 Bank lines categorized or matched to a record that no longer exists: 2',
      `      Bank line #${categorized}, 2026-06-02, 500.00 in Bank Account (#${accounts.bank}): categorized to bank transaction #987090, which no longer exists`,
      `      Bank line #${matched}, 2026-06-02, -75.00 in Bank Account (#${accounts.bank}): matched to expense #987091, which no longer exists`,
    ]);
    const possible = sectionLines(result, 'H12 Bank lines that may');
    expect(possible[0]).toBe(
      '  H12 Bank lines that may be counted twice (listed only, not counted as problems): 1',
    );
    expect(possible[2]).toBe(
      `      Bank line #${reused}, 2026-06-02, 300.00 in Bank Account (#${accounts.bank}) (categorized to Bank transaction #${deposit}) and payment received HC3-PAY-${tag} (#${leftover})`,
    );
  });

  it('H13 lists published documents with no or wrong ledger entries, not drafts (E1)', async () => {
    const customerId = await contact('customer');
    const invoice = (invoiceNo: string, deliveredAt: string | null) =>
      insert('sales_invoices', {
        customerId,
        invoiceNo: `${invoiceNo}-${tag}`,
        invoiceDate: '2026-06-04',
        dueDate: '2026-06-30',
        balance: 1000,
        currencyCode: 'USD',
        exchangeRate: 1,
        deliveredAt,
      });
    const unposted = await invoice('HC3-INV-412', '2026-06-04');
    await invoice('HC3-INV-413', null); // A draft: nothing to post.
    const posted = await invoice('HC3-INV-414', '2026-06-04');
    await post('SaleInvoice', posted, [
      [accounts.receivable, 1000, 0],
      [accounts.income, 0, 1000],
    ]);
    // A bill of 600 whose entries only put 500 on A/P.
    const short = await bill('HC3-BIL-415', 600, true);
    await post('Bill', short, [
      [accounts.inventory, 500, 0],
      [accounts.payable, 0, 500],
    ]);

    let result = await run();
    expect(sectionLines(result, 'H13')).toEqual([
      "  H13 Published documents with no ledger entries, or entries that don't add up to the document (accrual entries; company reports on the accrual basis): 2",
      `      Invoice HC3-INV-412-${tag} (#${unposted}), 2026-06-04, 1,000.00: no ledger entries`,
      `      Bill HC3-BIL-415-${tag} (#${short}), 2026-06-01, 600.00: entries put 500.00 on its account`,
    ]);

    // On the cash basis, a payment with no cash basis entries is listed
    // too (its accrual entries are fine).
    await db('settings')
      .where({ group: 'organization', key: 'accounting_basis' })
      .delete();
    await insert('settings', {
      group: 'organization',
      key: 'accounting_basis',
      value: 'cash',
    });
    try {
      result = await run();
      const lines = sectionLines(result, 'H13');
      expect(lines[0]).toContain('company reports on the cash basis): 3');
      expect(lines).toContain(
        `      Payment received HC3-PAY-${tag} (#${
          (await db('payment_receives')
            .where('paymentReceiveNo', `HC3-PAY-${tag}`)
            .first('id'))!.id
        }), 2026-06-02, 300.00: no cash basis entries (missing from the cash basis reports)`,
      );
    } finally {
      await db('settings')
        .where({ group: 'organization', key: 'accounting_basis' })
        .update({ value: 'accrual' });
    }
  });

  it('H13 compares a cash-only journal with its cash basis entries', async () => {
    const journal = await insert('manual_journals', {
      journalNumber: `HC3-MJ-CASH-${tag}`,
      date: '2026-06-04',
      amount: 200,
      currencyCode: 'USD',
      exchangeRate: 1,
      basis: 'cash',
      publishedAt: '2026-06-04',
    });
    await post(
      'Journal',
      journal,
      [
        [accounts.bank, 200, 0],
        [accounts.income, 0, 200],
      ],
      { basis: 'cash' },
    );
    const lines = sectionLines(await run(), 'H13');
    expect(lines.some((line) => line.includes(`HC3-MJ-CASH-${tag}`))).toBe(
      false,
    );
  });

  it('H14 lists invoices whose tax rows are missing, and rows of a deleted invoice (E8)', async () => {
    const customerId = await contact('customer');
    const taxRateId = await insert('tax_rates', {
      name: `HC3 VAT ${tag}`,
      code: `V${tag}`.slice(0, 10),
      rate: 15,
      active: 1,
    });
    const taxedInvoice = async (invoiceNo: string) => {
      const id = await insert('sales_invoices', {
        customerId,
        invoiceNo: `${invoiceNo}-${tag}`,
        invoiceDate: '2026-06-05',
        dueDate: '2026-06-30',
        balance: 1000,
        taxAmountWithheld: 150,
        isInclusiveTax: 0,
        currencyCode: 'USD',
        exchangeRate: 1,
      });
      await insert('items_entries', {
        referenceType: 'SaleInvoice',
        referenceId: id,
        index: 1,
        itemId: await item(`HC3 Taxed ${invoiceNo}`, 'service'),
        quantity: 1,
        rate: 1000,
        taxRateId,
        taxRate: 15,
      });
      return id;
    };
    // Its tax rows were lost by a cancelled bulk delete.
    const lost = await taxedInvoice('HC3-INV-388');
    // Its tax rows are there.
    const kept = await taxedInvoice('HC3-INV-389');
    await insert('tax_rate_transactions', {
      taxRateId,
      referenceType: 'SaleInvoice',
      referenceId: kept,
      rate: 15,
    });
    // A tax row of an invoice that is gone.
    await insert('tax_rate_transactions', {
      taxRateId,
      referenceType: 'SaleInvoice',
      referenceId: 987388,
      rate: 15,
    });

    const result = await run();
    expect(sectionLines(result, 'H14')).toEqual([
      '  H14 Invoices and bills whose tax rows do not match their taxed lines: 2',
      `      Invoice HC3-INV-388-${tag} (#${lost}) (draft): tax 150.00, lines use rates #${taxRateId}, tax rows 0`,
      `      Invoice #987388, which no longer exists: tax rows for rates #${taxRateId}`,
    ]);
  });

  it('H15 lists a foreign payment made by bank matching at rate 1 (B5)', async () => {
    const customerId = await contact('customer', 'EUR');
    const line = await bankLine(1000, { date: '2026-06-06' });
    const atOne = await insert('payment_receives', {
      customerId,
      paymentDate: '2026-06-06',
      amount: 1000,
      paymentReceiveNo: `HC3-PAY-51-${tag}`,
      depositAccountId: accounts.bank,
      currencyCode: 'EUR',
      exchangeRate: 1,
    });
    await post('PaymentReceive', atOne, [
      [accounts.bank, 1000, 0],
      [accounts.receivable, 0, 1000],
    ]);
    // As a match stores it: the invoice and the payment it created.
    for (const [referenceType, referenceId] of [
      ['SaleInvoice', 987051],
      ['PaymentReceive', atOne],
    ] as const) {
      await insert('matched_bank_transactions', {
        uncategorizedTransactionId: line,
        referenceType,
        referenceId,
        amount: 1000,
      });
    }
    // A foreign payment at a real rate isn't listed.
    const atRate = await insert('payment_receives', {
      customerId,
      paymentDate: '2026-06-06',
      amount: 10,
      paymentReceiveNo: `HC3-PAY-52-${tag}`,
      depositAccountId: accounts.bank,
      currencyCode: 'EUR',
      exchangeRate: 1.1,
    });
    await post('PaymentReceive', atRate, [
      [accounts.bank, 11, 0],
      [accounts.receivable, 0, 11],
    ]);
    await insert('matched_bank_transactions', {
      uncategorizedTransactionId: await bankLine(11, { date: '2026-06-06' }),
      referenceType: 'PaymentReceive',
      referenceId: atRate,
      amount: 11,
    });

    const result = await run();
    expect(sectionLines(result, 'H15')).toEqual([
      '  H15 Payments made by bank matching for a foreign document at rate 1: 1',
      `      Payment received HC3-PAY-51-${tag} (#${atOne}), 2026-06-06: EUR 1,000.00 at rate 1 (base USD), matched to bank line #${line}`,
    ]);
    // The match's invoice is gone: H12 lists that link too.
    expect(result.bankLinesToMissingRecords).toContainEqual(
      expect.objectContaining({
        lineId: line,
        referenceType: 'SaleInvoice',
        referenceId: 987051,
      }),
    );
  });

  it('H16 lists duplicate stock rows and what the Q3 migration would merge (Q3)', async () => {
    const chair = await item('HC3 Chair');
    const warehouseId =
      (await db('warehouses').first('id'))?.id ??
      (await insert('warehouses', { name: `HC3 Main ${tag}`, code: tag }));
    // With the Q3 unique index (migration 20261107130000) the database
    // refuses a second row; old data from before it is written here by
    // dropping it in this test company (the item's foreign key needs an
    // index of its own then).
    const [indexes] = await db.raw('SHOW INDEX FROM ??', [
      'items_warehouses_quantity',
    ]);
    const names = indexes.map((row: any) =>
      String(row.Key_name ?? row.KEY_NAME).toLowerCase(),
    );
    if (names.includes(STOCK_INDEX)) {
      await db.raw('ALTER TABLE ?? ADD INDEX ?? (??)', [
        'items_warehouses_quantity',
        'hc3_item_id',
        'item_id',
      ]);
      await db.raw('ALTER TABLE ?? DROP INDEX ??', [
        'items_warehouses_quantity',
        STOCK_INDEX,
      ]);
    }
    // Two first movements at once: two rows, and both took the later
    // changes, so each shows the real 5.
    for (let i = 0; i < 2; i += 1) {
      await insert('items_warehouses_quantity', {
        itemId: chair,
        warehouseId,
        quantityOnHand: 5,
      });
    }
    await insert('inventory_transactions', {
      date: '2026-06-07',
      direction: 'IN',
      itemId: chair,
      warehouseId,
      quantity: 5,
      rate: 10,
      transactionType: 'Bill',
      transactionId: 987016,
    });
    const warehouseName = (
      await db('warehouses').where('id', warehouseId).first()
    ).name;

    const result = await run();
    expect(sectionLines(result, 'H16')).toEqual([
      '  H16 Duplicate stock rows per item and warehouse: 1',
      `      Item HC3 Chair ${tag} (#${chair}) / warehouse ${warehouseName} (#${warehouseId}): 2 rows (5, 5); the Q3 migration would store 10, the stock movements add up to 5 (check after merging: H3)`,
      '      Q3 migration (one stock row per item and warehouse): would merge 2 rows into 1 (1 items), summing their quantities',
    ]);
    expect(isRound3DataHealthClean(result)).toBe(false);
  });
});
