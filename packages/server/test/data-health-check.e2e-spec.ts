import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany, systemKnex } from './_utils/security';
import {
  checkDataHealth,
  checkSystemDataHealth,
  formatDataHealth,
  formatSystemDataHealth,
  IDataHealthResult,
  isDataHealthClean,
} from '../src/modules/AccountingBasis/DataHealthCheck';

/**
 * Package 6 data health check (H1–H8). A new company is built, checked
 * clean ("none" in every section), then one bad record of each kind is
 * written straight into its database (the fixed code no longer makes them)
 * and each is checked to be listed. The check itself runs on connections
 * set to read only, so any write it tried would fail.
 */
// Each test adds to the same company, so a retry would add twice.
jest.retryTimes(0);

describe('Data health check (H1–H8)', () => {
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

  let accounts: { inventory: number; cost: number; other: number };
  const insert = async (table: string, row: Record<string, any>) =>
    (await db(table).insert(row))[0] as number;

  const customer = () =>
    insert('contacts', {
      contactService: 'customer',
      contactType: 'business',
      displayName: `HC customer ${tag}`,
      currencyCode: 'USD',
      active: 1,
      balance: 0,
    });
  const vendor = () =>
    insert('contacts', {
      contactService: 'vendor',
      contactType: 'business',
      displayName: `HC supplier ${tag}`,
      currencyCode: 'USD',
      active: 1,
      balance: 0,
    });
  const item = (name: string, quantityOnHand: number) =>
    insert('items', {
      name: `${name} ${tag}`,
      type: 'inventory',
      sellable: 1,
      purchasable: 1,
      quantityOnHand,
      costAccountId: accounts.cost,
      sellAccountId: accounts.other,
      inventoryAccountId: accounts.inventory,
      active: 1,
    });
  const movement = (row: Record<string, any>) =>
    insert('inventory_transactions', { date: '2026-05-01', rate: 0, ...row });
  const bill = (billNumber: string, extra: Record<string, any> = {}) =>
    vendor().then((vendorId) =>
      insert('bills', {
        vendorId,
        billNumber,
        billDate: '2026-05-01',
        dueDate: '2026-05-31',
        amount: 0,
        currencyCode: 'USD',
        exchangeRate: 1,
        openedAt: '2026-05-01 10:00:00',
        ...extra,
      }),
    );

  beforeAll(async () => {
    company = await createCompany(app, 'health');
    const prefix = app.get(ConfigService).get('tenantDatabase.dbNamePrefix');
    db = connect(`${prefix}${company.organizationId}`, false);
    readOnlyDb = connect(`${prefix}${company.organizationId}`, true);
    sys = systemKnex(app);
    const systemDatabase = app
      .get(ConfigService)
      .get('systemDatabase.databaseName');
    readOnlySystemDb = connect(systemDatabase, true);

    const byType = (type: string) =>
      db('accounts').where('accountType', type).first('id');
    accounts = {
      inventory: (await byType('inventory')).id,
      cost: (await byType('cost-of-goods-sold')).id,
      other: (await byType('other-expense')).id,
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
      readOnlyDb('settings').insert({ group: 'hc', key: 'hc', value: '1' }),
    ).rejects.toThrow(/read.only/i);
  });

  it('a clean company prints "none" in every section', async () => {
    const result = await run();
    expect(isDataHealthClean(result)).toBe(true);
    expect(result.lockedDocuments).toEqual([]);

    const lines = formatDataHealth(result, 'USD');
    const titles = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^ {2}H\d/.test(line));
    expect(titles.map(({ line }) => line.slice(2, 4))).toEqual([
      'H1',
      'H2',
      'H3',
      'H3',
      'H4',
      'H5',
      'H7',
      'H8',
      'H8',
    ]);
    titles.forEach(({ line, index }) => {
      expect(line).toMatch(/: 0$/);
      // H2 prints its note first.
      const next = lines[index + (line.startsWith('  H2') ? 2 : 1)];
      expect(next).toBe('      none');
    });
    expect(lines.join('\n')).toContain(
      'Unique number index (P3, D5): can be added for all 11 document types',
    );
    // The company's creator is its one owner, and isn't listed.
    const owners = await sys('user_tenants').where({
      tenantId: company.tenantId,
      role: 'owner',
    });
    expect(owners.map((row) => row.userId)).toEqual([
      company.owner.systemUserId,
    ]);
  });

  it('H1 lists a foreign currency invoice saved at rate 1', async () => {
    const customerId = await customer();
    const atOne = await insert('sales_invoices', {
      customerId,
      invoiceNo: `HC-INV-31-${tag}`,
      invoiceDate: '2026-05-01',
      dueDate: '2026-05-31',
      balance: 100,
      currencyCode: 'EUR',
      exchangeRate: 1,
    });
    await insert('sales_invoices', {
      customerId,
      invoiceNo: `HC-INV-32-${tag}`,
      invoiceDate: '2026-05-01',
      dueDate: '2026-05-31',
      balance: 100,
      currencyCode: 'EUR',
      exchangeRate: 1.08,
    });
    const result = await run();
    expect(result.rateOneDocuments).toEqual([
      expect.objectContaining({
        documentType: 'SaleInvoice',
        documentId: atOne,
      }),
    ]);
    expect(sectionLines(result, 'H1')).toEqual([
      '  H1 Foreign currency documents saved at exchange rate 1: 1',
      `      Invoice HC-INV-31-${tag} (#${atOne}), 2026-05-01: EUR 100.00 at rate 1 (base USD)`,
    ]);
  });

  it('H2 lists a published invoice dated in a locked period, not a draft', async () => {
    const lock = await as(app, company.owner, company.organizationId)
      .put('/transactions-locking/lock')
      .send({
        module: 'sales',
        lock_to_date: '2026-03-31',
        reason: 'VAT filed',
      });
    expect(lock.status).toBe(200);

    const customerId = await customer();
    const published = await insert('sales_invoices', {
      customerId,
      invoiceNo: `HC-INV-44-${tag}`,
      invoiceDate: '2026-03-15',
      dueDate: '2026-03-31',
      balance: 10000,
      currencyCode: 'USD',
      exchangeRate: 1,
      deliveredAt: '2026-04-02',
    });
    await insert('sales_invoices', {
      customerId,
      invoiceNo: `HC-INV-45-${tag}`,
      invoiceDate: '2026-03-16',
      dueDate: '2026-03-31',
      balance: 500,
      currencyCode: 'USD',
      exchangeRate: 1,
    });
    const result = await run();
    expect(result.lockedDocuments).toEqual([
      expect.objectContaining({
        documentType: 'SaleInvoice',
        documentId: published,
        lockedTo: '2026-03-31',
        publishedAfterLockDate: true,
      }),
    ]);
    const lines = sectionLines(result, 'H2');
    expect(lines[0]).toContain('(listed only, not counted as problems): 1');
    expect(lines[1]).toContain(
      "can't tell whether each was published before or after the lock",
    );
    expect(lines[2]).toBe(
      `      Invoice HC-INV-44-${tag} (#${published}), 15 Mar 2026, period locked to 31 Mar 2026, published 2 Apr 2026 (after the lock date)`,
    );
    // Listed, not counted as a problem.
    expect(result.lockedDocuments.length).toBe(1);
  });

  it('H3 lists stock left by deleted and draft adjustments', async () => {
    const chair = await item('HC Chair A', -8);
    const draft = await insert('inventory_adjustments', {
      date: '2026-05-01',
      type: 'decrement',
      adjustmentAccountId: accounts.other,
      reason: 'damaged',
    });
    await movement({
      itemId: chair,
      direction: 'OUT',
      quantity: 5,
      transactionType: 'InventoryAdjustment',
      transactionId: 987654,
    });
    await movement({
      itemId: chair,
      direction: 'OUT',
      quantity: 3,
      transactionType: 'InventoryAdjustment',
      transactionId: draft,
    });
    const result = await run();
    expect(sectionLines(result, 'H3 Stock left')).toEqual([
      '  H3 Stock left by deleted or draft adjustments: 2',
      `      Adjustment #${draft} (draft): item HC Chair A ${tag} (#${chair}) -3`,
      `      Adjustment #987654 (deleted): item HC Chair A ${tag} (#${chair}) -5`,
    ]);
    // Its stock total matches its movements, so only (a) lists it.
    expect(result.stockTotalDifferences).toEqual([]);
  });

  it('H3 lists stock totals that differ from the movements, per item and warehouse', async () => {
    const chair = await item('HC Chair B', 25);
    await movement({
      itemId: chair,
      direction: 'IN',
      quantity: 20,
      transactionType: 'Bill',
      transactionId: 987001,
    });
    let result = await run();
    expect(sectionLines(result, 'H3 Stock totals')).toEqual([
      '  H3 Stock totals different from the stock movements (per item; multi-warehouse is off): 1',
      `      Item HC Chair B ${tag} (#${chair}): stock shows 25, movements add up to 20`,
    ]);

    // Per warehouse once multi-warehouse is on.
    const table = await db('items').where('id', chair).first();
    const warehouseId =
      (await db('warehouses').first('id'))?.id ??
      (await insert('warehouses', { name: `HC ${tag}`, code: tag }));
    await db('settings').insert({
      group: 'features',
      key: 'warehouses',
      value: '1',
    });
    try {
      await db('items').where('id', chair).update({ quantityOnHand: 20 });
      await db('inventory_transactions')
        .where({ itemId: chair })
        .update({ warehouseId });
      await insert('items_warehouses_quantity', {
        itemId: chair,
        warehouseId,
        quantityOnHand: 17.5,
      });
      result = await run();
      expect(result.warehousesChecked).toBe(true);
      expect(sectionLines(result, 'H3 Stock totals')).toEqual([
        '  H3 Stock totals different from the stock movements (per item and per warehouse): 1',
        `      Item HC Chair B ${tag} (#${chair}) in warehouse #${warehouseId}: stock shows 17.5, movements add up to 20`,
      ]);
    } finally {
      await db('settings')
        .where({ group: 'features', key: 'warehouses' })
        .delete();
      await db('items_warehouses_quantity').where('itemId', chair).delete();
      await db('items').where('id', chair).update({
        quantityOnHand: table.quantityOnHand,
      });
    }
  });

  it('H4 lists a published write-off with no ledger entry', async () => {
    const chair = await item('HC Chair C', 0);
    const adjustment = async (referenceNo: string) => {
      const id = await insert('inventory_adjustments', {
        date: '2026-05-02',
        type: 'decrement',
        adjustmentAccountId: accounts.other,
        reason: 'damaged',
        referenceNo,
        publishedAt: '2026-05-02 10:00:00',
      });
      await insert('inventory_adjustments_entries', {
        adjustmentId: id,
        index: 1,
        itemId: chair,
        quantity: 5,
      });
      await insert('inventory_cost_lot_tracker', {
        date: '2026-05-02',
        direction: 'OUT',
        itemId: chair,
        quantity: 5,
        rate: 50,
        cost: 250,
        transactionType: 'InventoryAdjustment',
        transactionId: id,
      });
      return id;
    };
    const unposted = await adjustment(`ADJ-00009-${tag}`);
    const posted = await adjustment(`ADJ-00010-${tag}`);
    for (const [accountId, debit, credit] of [
      [accounts.other, 250, 0],
      [accounts.inventory, 0, 250],
    ]) {
      await insert('accounts_transactions', {
        referenceType: 'InventoryAdjustment',
        referenceId: posted,
        accountId,
        debit,
        credit,
        date: '2026-05-02',
        currencyCode: 'USD',
        exchangeRate: 1,
      });
    }
    const result = await run();
    expect(sectionLines(result, 'H4')).toEqual([
      '  H4 Published decrease adjustments with no ledger entry: 1',
      `      Adjustment #${unposted} (ADJ-00009-${tag}), 2026-05-02: -5 units, 250.00 cost, no ledger entry`,
    ]);
  });

  it('H5 lists a credit note number used twice (case ignored, like a unique index)', async () => {
    const customerId = await customer();
    const number = `CN-HC-${tag}`.toUpperCase();
    const creditNote = (creditNoteNumber: string) =>
      insert('credit_notes', {
        customerId,
        creditNoteNumber,
        creditNoteDate: '2026-05-03',
        amount: 10,
        currencyCode: 'USD',
        exchangeRate: 1,
      });
    // The unique number index (migration 20261103120100) refuses a second
    // credit note with the same number, in any case.
    const first = await creditNote(number);
    await expect(creditNote(number.toLowerCase())).rejects.toThrow(
      /Duplicate entry/,
    );
    await db('credit_notes').where('id', first).delete();

    // Old data from before the index: drop it in this test company to write
    // the duplicates the check has to find.
    await db.raw('ALTER TABLE ?? DROP INDEX ??', [
      'credit_notes',
      'credit_notes_doc_number_unique',
    ]);
    const ids: number[] = [];
    for (const creditNoteNumber of [number, number, number.toLowerCase()]) {
      ids.push(
        await insert('credit_notes', {
          customerId,
          creditNoteNumber,
          creditNoteDate: '2026-05-03',
          amount: 10,
          currencyCode: 'USD',
          exchangeRate: 1,
        }),
      );
    }
    const result = await run();
    expect(result.duplicateNumbers).toEqual([
      expect.objectContaining({
        documentType: 'CreditNote',
        count: 3,
        documentIds: ids,
      }),
    ]);
    const lines = sectionLines(result, 'H5');
    expect(lines[0]).toBe('  H5 Duplicate document numbers: 1');
    expect(lines[1].toUpperCase()).toBe(
      `      CREDIT NOTE ${number} IS USED BY 3 DOCUMENTS (#${ids.join(', #')})`,
    );
    expect(lines[2]).toBe(
      '      Unique number index (P3, D5): can be added for 10 of 11 types; not yet for Credit note',
    );
  });

  it('H6 lists a login email used twice in another case', async () => {
    const email = `hc-dup-${tag}@example.com`;
    const before = await checkSystemDataHealth(readOnlySystemDb);
    expect(before.duplicateLoginEmails.map((row) => row.email)).not.toContain(
      email,
    );
    const ids: number[] = [];
    const addLogin = async (variant: string) => {
      const [id] = await sys('users').insert({
        firstName: 'HC',
        email: variant,
        active: 1,
      });
      ids.push(id);
      systemUserIds.push(id);
    };
    // With the unique login email index (migration 20261103120300) the
    // database refuses a second login with the email, in any case. The
    // index is shared by every company, so it is dropped only for the few
    // statements that write the old-style duplicate, and the duplicate is
    // removed again before the index is put back.
    const [indexRows] = await sys.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [
      'users',
      'USERS_EMAIL_UNIQUE',
    ]);
    const hasIndex = indexRows.length > 0;
    await addLogin(email);
    let after: Awaited<ReturnType<typeof checkSystemDataHealth>>;
    if (hasIndex) {
      await expect(addLogin(email.toUpperCase())).rejects.toThrow(
        /Duplicate entry/,
      );
      await sys.raw('ALTER TABLE ?? DROP INDEX ??', [
        'users',
        'users_email_unique',
      ]);
    }
    try {
      await addLogin(email.toUpperCase());
      after = await checkSystemDataHealth(readOnlySystemDb);
    } finally {
      if (hasIndex) {
        await sys('users')
          .where('id', ids[ids.length - 1])
          .delete();
        await sys.raw('ALTER TABLE ?? ADD UNIQUE INDEX ?? (??)', [
          'users',
          'users_email_unique',
          'email',
        ]);
      }
    }
    const row = after.duplicateLoginEmails.find((r) => r.email === email);
    expect(row?.users.map((user) => user.id)).toEqual(ids);
    expect(formatSystemDataHealth(after)).toContain(
      `      ${email} is used by 2 logins (#${ids[0]} ${email}, #${ids[1]} ${email.toUpperCase()})`,
    );
    expect(formatSystemDataHealth(after).join('\n')).toMatch(
      /Unique login email index \(S1, D5\): not yet: \d+ emails are shared/,
    );
  });

  it('H7 lists owner rows of invited members and other non-creators', async () => {
    const login = async (label: string) => {
      const [id] = await sys('users').insert({
        firstName: 'HC',
        email: `hc-${label}-${tag}@example.com`,
        active: 1,
        tenantId: company.tenantId,
        createdAt: new Date(),
      });
      systemUserIds.push(id);
      // As the March backfill did: an owner row for the company.
      await sys('user_tenants').insert({
        userId: id,
        tenantId: company.tenantId,
        role: 'owner',
        createdAt: new Date(),
      });
      return id;
    };
    const invited = await login('invited');
    await insert('users', {
      email: `hc-invited-${tag}@example.com`,
      systemUserId: invited,
      active: 1,
      invitedAt: '2026-04-01 10:00:00',
      inviteAcceptedAt: '2026-04-02 10:00:00',
    });
    const notAUser = await login('gone');
    const second = await login('second');
    await insert('users', {
      email: `hc-second-${tag}@example.com`,
      systemUserId: second,
      active: 1,
    });

    const result = await run();
    expect(result.ownerMemberships).toEqual([
      {
        userId: invited,
        email: `hc-invited-${tag}@example.com`,
        reason: 'invited',
      },
      {
        userId: notAUser,
        email: `hc-gone-${tag}@example.com`,
        reason: 'not_a_user',
      },
      {
        userId: second,
        email: `hc-second-${tag}@example.com`,
        reason: 'second_owner',
      },
    ]);
    expect(sectionLines(result, 'H7')).toEqual([
      '  H7 Owners who did not create the company: 3',
      `      hc-invited-${tag}@example.com (login #${invited}): owner, joined by invite`,
      `      hc-gone-${tag}@example.com (login #${notAUser}): owner, not a user of the company`,
      `      hc-second-${tag}@example.com (login #${second}): owner, another owner was a user of the company first`,
    ]);
  });

  it('H8 lists an untagged landed cost from a bill, not a tagged one', async () => {
    const freight = await bill(`HC-FRT-${tag}`);
    const goods = await bill(`HC-GDS-${tag}`);
    const landedCost = async (basis: string | null) => {
      const id = await insert('bill_located_costs', {
        amount: 2000,
        currencyCode: 'USD',
        exchangeRate: 1,
        fromTransactionId: freight,
        fromTransactionType: 'Bill',
        allocationMethod: 'value',
        costAccountId: accounts.cost,
        billId: goods,
      });
      for (const [accountId, debit, credit] of [
        [accounts.inventory, 2000, 0],
        [accounts.cost, 0, 2000],
      ]) {
        await insert('accounts_transactions', {
          referenceType: 'LandedCost',
          referenceId: id,
          accountId,
          debit,
          credit,
          date: '2026-05-01',
          currencyCode: 'USD',
          exchangeRate: 1,
          basis,
        });
      }
      return id;
    };
    const untagged = await landedCost(null);
    await landedCost('accrual');

    const result = await run();
    expect(sectionLines(result, 'H8 Landed costs')).toEqual([
      '  H8 Landed costs from bills posted before the inventory fix (untagged, on both bases): 1',
      `      Landed cost #${untagged}: 2,000.00 from bill HC-FRT-${tag} (#${freight}) onto bill HC-GDS-${tag} (#${goods}), 2026-05-01: 2 untagged ledger rows`,
    ]);
  });

  it('H8 lists bill stock costed with the VAT included, not a net one', async () => {
    const chair = await item('HC Chair D', 20);
    const billId = await bill(`HC-VAT-${tag}`, { isInclusiveTax: 1 });
    const line = async (index: number, rate: number, inclusive: number) => {
      const entryId = await insert('items_entries', {
        referenceType: 'Bill',
        referenceId: billId,
        index,
        itemId: chair,
        quantity: 10,
        rate,
        taxRate: 10,
        isInclusiveTax: inclusive,
      });
      for (const table of [
        'inventory_transactions',
        'inventory_cost_lot_tracker',
      ]) {
        await insert(table, {
          date: '2026-05-01',
          direction: 'IN',
          itemId: chair,
          quantity: 10,
          // The old code: the raw unit price.
          rate,
          transactionType: 'Bill',
          transactionId: billId,
          entryId,
          ...(table === 'inventory_cost_lot_tracker' && {
            cost: rate * 10,
            remaining: 10,
          }),
        });
      }
      return entryId;
    };
    // 110 with 10% VAT inside: the books put 1,000 into stock.
    const inclusive = await line(1, 110, 1);
    // 100 with 10% VAT on top: 1,000 into stock, which the lots match.
    await line(2, 100, 0);

    const result = await run();
    expect(sectionLines(result, 'H8 Bill stock')).toEqual([
      '  H8 Bill stock costed at the raw line price: 2',
      `      Bill HC-VAT-${tag} (#${billId}) line #${inclusive}, item HC Chair D ${tag} (#${chair}), 10 units: stock movement 1,100.00, books 1,000.00 (VAT included)`,
      `      Bill HC-VAT-${tag} (#${billId}) line #${inclusive}, item HC Chair D ${tag} (#${chair}), 10 units: cost lot 1,100.00, books 1,000.00 (VAT included)`,
    ]);
    expect(isDataHealthClean(result)).toBe(false);
  });
});
