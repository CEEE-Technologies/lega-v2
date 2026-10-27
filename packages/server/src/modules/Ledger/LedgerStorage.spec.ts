import { sumMoneyBy } from '@bigcapital/utils';
import { ACCOUNT_TYPE } from '@/constants/accounts';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { LedgerStorageService } from './LedgerStorage.service';
import { Ledger } from './Ledger';
import { ILedger, ILedgerEntry } from './types/Ledger.types';
import { normalizeLedgerEntries } from './LedgerNormalizer';

const AR = 1;
const BANK = 2;
const INCOME_A = 3;
const INCOME_B = 4;
const TAX = 5;
const FX = 6;
const INVENTORY = 7;
const COGS = 8;

const ACCOUNT_TYPES = new Map<number, string>([
  [AR, ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE],
  [BANK, ACCOUNT_TYPE.BANK],
  [INCOME_A, ACCOUNT_TYPE.INCOME],
  [INCOME_B, ACCOUNT_TYPE.INCOME],
  [TAX, ACCOUNT_TYPE.TAX_PAYABLE],
  [FX, ACCOUNT_TYPE.OTHER_EXPENSE],
  [INVENTORY, ACCOUNT_TYPE.INVENTORY],
  [COGS, ACCOUNT_TYPE.COST_OF_GOODS_SOLD],
]);

const entry = (overrides: Partial<ILedgerEntry>): ILedgerEntry => ({
  debit: 0,
  credit: 0,
  currencyCode: 'LKR',
  exchangeRate: 1,
  accountNormal: 'debit',
  date: '2026-01-01',
  transactionType: 'SaleInvoice',
  transactionId: 1,
  index: 1,
  basis: AccountingBasis.Accrual,
  ...overrides,
});

const debits = (entries: ILedgerEntry[]) => sumMoneyBy(entries, 'debit');
const credits = (entries: ILedgerEntry[]) => sumMoneyBy(entries, 'credit');

const isCents = (value: number) => Math.round(value * 100) / 100 === value;

/**
 * Builds the service with recording fakes of its four consumers.
 */
const buildService = () => {
  const received: Record<string, ILedger> = {};
  const record = (name: string) =>
    jest.fn(async (ledger: ILedger) => {
      received[name] = ledger;
    });

  const ledgerEntries = {
    saveEntries: record('entries'),
    deleteEntries: jest.fn(),
  };
  const accountsBalance = { saveAccountsBalance: record('accounts') };
  const contactsBalance = { saveContactsBalance: record('contacts') };
  const clickHouse = {
    onLedgerCommitted: jest.fn((ledger: ILedger) => {
      received.analytics = ledger;
    }),
    onLedgerDeleted: jest.fn(),
  };
  const accountModel = () => ({
    query: () => ({
      whereIn: (_column: string, ids: number[]) => ({
        select: async () =>
          ids.map((id) => ({ id, accountType: ACCOUNT_TYPES.get(id) })),
      }),
    }),
  });
  const service = new LedgerStorageService(
    contactsBalance as any,
    accountsBalance as any,
    ledgerEntries as any,
    (() => ({})) as any,
    clickHouse as any,
    accountModel as any,
  );
  return { service, received };
};

describe('LedgerStorageService.commit', () => {
  const originalStrict = process.env.LEDGER_STRICT_MODE;

  afterEach(() => {
    process.env.LEDGER_STRICT_MODE = originalStrict;
  });

  it('gives the four consumers the same rounded, balanced entries', async () => {
    const { service, received } = buildService();

    // 3 x 33.333.. income lines and an exchange-rate converted receivable.
    const ledger = new Ledger([
      entry({ accountId: AR, debit: 100 }),
      entry({ accountId: INCOME_A, credit: 100 / 3 }),
      entry({ accountId: INCOME_B, credit: 100 / 3 }),
      entry({ accountId: TAX, credit: 100 / 3 }),
    ]);
    await service.commit(ledger);

    const entries = received.entries.getEntries();
    expect(received.accounts).toBe(received.entries);
    expect(received.contacts).toBe(received.entries);
    expect(received.analytics).toBe(received.entries);

    entries.forEach((e) => {
      expect(isCents(e.debit)).toBe(true);
      expect(isCents(e.credit)).toBe(true);
    });
    expect(debits(entries)).toBe(credits(entries));

    // The leftover cent goes on an income line, never A/R or tax.
    expect(entries[0].debit).toBe(100);
    expect(entries[3].credit).toBe(33.33);
    expect(entries[1].credit + entries[2].credit).toBeCloseTo(66.67, 10);
  });

  it('passes a reversal of stored entries through unchanged', async () => {
    const { service, received } = buildService();
    const stored = new Ledger([
      entry({ accountId: AR, credit: 100, entryId: 11 }),
      entry({ accountId: INCOME_A, debit: 33.333, entryId: 12 }),
      entry({ accountId: INCOME_B, debit: 33.333, entryId: 13 }),
      entry({ accountId: TAX, debit: 33.334, entryId: 14 }),
    ]);
    await service.commit(stored);

    expect(received.entries).toBe(stored);
    expect(received.entries.getEntries().map((e) => e.debit)).toEqual([
      0, 33.333, 33.333, 33.334,
    ]);
  });

  it('balances the cash and accrual sets of a transaction separately', async () => {
    const { service, received } = buildService();
    const common = { transactionType: 'PaymentReceive', transactionId: 7 };

    await service.commit(
      new Ledger([
        entry({ ...common, accountId: BANK, debit: 100 }),
        entry({ ...common, accountId: AR, credit: 100 }),
        entry({
          ...common,
          basis: AccountingBasis.Cash,
          accountId: BANK,
          debit: 100,
        }),
        entry({
          ...common,
          basis: AccountingBasis.Cash,
          accountId: INCOME_A,
          credit: 200 / 3,
        }),
        entry({
          ...common,
          basis: AccountingBasis.Cash,
          accountId: TAX,
          credit: 100 / 3,
        }),
      ]),
    );
    const entries = received.entries.getEntries();
    const accrual = entries.filter((e) => e.basis === AccountingBasis.Accrual);
    const cash = entries.filter((e) => e.basis === AccountingBasis.Cash);

    expect(debits(accrual)).toBe(100);
    expect(credits(accrual)).toBe(100);
    expect(debits(cash)).toBe(100);
    expect(credits(cash)).toBe(100);
    expect(cash.find((e) => e.accountId === INCOME_A).credit).toBe(66.67);
    expect(cash.find((e) => e.accountId === TAX).credit).toBe(33.33);
  });

  it('rounds an average inventory cost pair to the same cents', async () => {
    const { service, received } = buildService();
    const common = { transactionType: 'InventoryAdjustment', transactionId: 3 };

    await service.commit(
      new Ledger([
        entry({ ...common, accountId: INVENTORY, debit: 3795.896 }),
        entry({ ...common, accountId: COGS, credit: 3795.896 }),
      ]),
    );
    const entries = received.entries.getEntries();
    expect(entries.map((e) => e.debit + e.credit)).toEqual([3795.9, 3795.9]);
  });

  it('converts a foreign currency invoice to exact cents', async () => {
    const { service, received } = buildService();
    const rate = 312.456789;
    const common = { currencyCode: 'USD', exchangeRate: rate };

    await service.commit(
      new Ledger([
        entry({ ...common, accountId: AR, debit: 100.01 * rate }),
        entry({ ...common, accountId: INCOME_A, credit: 33.34 * rate }),
        entry({ ...common, accountId: INCOME_B, credit: 66.67 * rate }),
      ]),
    );
    const entries = received.entries.getEntries();
    // 100.01 x 312.456789 = 31248.80346789
    expect(entries[0].debit).toBe(31248.8);
    expect(debits(entries)).toBe(credits(entries));
  });

  it('takes the account normal from the account type', async () => {
    const { service, received } = buildService();
    // A cost line marked credit-normal on a debit-normal (COGS) account.
    await service.commit(
      new Ledger([
        entry({ accountId: INVENTORY, debit: 200, accountNormal: 'debit' }),
        entry({ accountId: COGS, credit: 200, accountNormal: 'credit' }),
      ]),
    );
    const entries = received.accounts.getEntries();
    expect(entries.map((e) => e.accountNormal)).toEqual(['debit', 'debit']);
    // The COGS balance goes down by the credit.
    expect(received.accounts.whereAccountId(COGS).getClosingBalance()).toBe(
      -200,
    );
  });

  it('logs a set off by more than rounding, and throws in strict mode', async () => {
    const unbalanced = () =>
      new Ledger([
        entry({ accountId: AR, debit: 100 }),
        entry({ accountId: INCOME_A, credit: 90 }),
      ]);
    process.env.LEDGER_STRICT_MODE = '';
    const { service, received } = buildService();
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await service.commit(unbalanced());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SaleInvoice #1 [accrual] debits - credits = 10'),
    );
    expect(received.entries.getEntries()[1].credit).toBe(90);

    process.env.LEDGER_STRICT_MODE = 'true';
    await expect(service.commit(unbalanced())).rejects.toThrow(
      /Unbalanced ledger entries: SaleInvoice #1/,
    );
  });
});

describe('normalizeLedgerEntries', () => {
  it('never puts the leftover on A/R, A/P or bank lines', () => {
    const { entries } = normalizeLedgerEntries(
      [
        entry({ accountId: BANK, debit: 10.005 }),
        entry({ accountId: AR, credit: 9.004 }),
        entry({ accountId: TAX, credit: 1.001 }),
      ],
      ACCOUNT_TYPES,
    );
    // 10.01 debit vs 9.00 + 1.00 credit: tax (not A/R, not bank) takes the cent.
    expect(entries.map((e) => [e.debit, e.credit])).toEqual([
      [10.01, 0],
      [0, 9],
      [0, 1.01],
    ]);
  });

  it('puts the leftover on the largest income/expense line', () => {
    const { entries } = normalizeLedgerEntries(
      [
        entry({ accountId: AR, debit: 1000 }),
        entry({ accountId: INCOME_A, credit: 333.333 }),
        entry({ accountId: INCOME_B, credit: 555.556 }),
        entry({ accountId: TAX, credit: 111.111 }),
      ],
      ACCOUNT_TYPES,
    );
    expect(entries.map((e) => e.credit)).toEqual([0, 333.33, 555.56, 111.11]);
  });

  it('keeps the exchange gain/loss line taking the difference', () => {
    const common = { transactionType: 'PaymentReceive', transactionId: 2 };
    const { entries, unbalanced } = normalizeLedgerEntries(
      [
        entry({ ...common, accountId: BANK, debit: 31245.6789 }),
        entry({ ...common, accountId: AR, credit: 31000.0049 }),
        entry({ ...common, accountId: FX, credit: 245.674 }),
      ],
      ACCOUNT_TYPES,
    );
    expect(unbalanced).toEqual([]);
    expect(entries[0].debit).toBe(31245.68);
    expect(entries[1].credit).toBe(31000);
    expect(entries[2].credit).toBe(245.68);
  });
});
