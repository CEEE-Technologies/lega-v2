import { balanceEntries, fromCents } from '@bigcapital/utils';
import { ACCOUNT_TYPE } from '@/constants/accounts';
import { ILedgerEntry } from './types/Ledger.types';

/**
 * Account types that may take a rounding leftover: income and expense
 * lines. Never the customer/vendor balance (A/R, A/P) or bank lines, so
 * contact balances and bank amounts always match the document exactly.
 */
const PLUG_ACCOUNT_TYPES = [
  ACCOUNT_TYPE.INCOME,
  ACCOUNT_TYPE.OTHER_INCOME,
  ACCOUNT_TYPE.COST_OF_GOODS_SOLD,
  ACCOUNT_TYPE.EXPENSE,
  ACCOUNT_TYPE.OTHER_EXPENSE,
];

/**
 * Account types that never take a rounding leftover.
 */
const NEVER_PLUG_ACCOUNT_TYPES = [
  ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
  ACCOUNT_TYPE.ACCOUNTS_PAYABLE,
  ACCOUNT_TYPE.BANK,
  ACCOUNT_TYPE.CASH,
  ACCOUNT_TYPE.CREDIT_CARD,
];

export interface ILedgerUnbalancedGroup {
  transactionType: string;
  transactionId: number;
  basis: string | null;
  /** Debits minus credits in cents, after rounding. */
  leftoverCents: number;
}

export interface ILedgerNormalizeResult {
  entries: ILedgerEntry[];
  /** Groups off by more than a rounding leftover (a real bug). */
  unbalanced: ILedgerUnbalancedGroup[];
}

const groupKey = (entry: ILedgerEntry) =>
  `${entry.transactionType}|${entry.transactionId}|${entry.basis ?? ''}`;

/**
 * Normalises the ledger entries before they are stored:
 * 1. rounds every debit and credit to cents,
 * 2. groups the entries by transaction and basis, and checks debits equal
 *    credits in each group,
 * 3. puts a rounding-sized leftover on the largest income/expense line of the
 *    group (never on the A/R, A/P or bank lines),
 * 4. reports a group off by more than rounding instead of hiding it.
 *
 * A group with stored entries (`entryId`, e.g. a reversal of stored lines)
 * is returned unchanged: re-rounding a stored 33.333 to 33.33 would leave
 * 0.003 behind.
 * @param {ILedgerEntry[]} entries
 * @param {Map<number, string>} accountTypes - Account type by account id.
 * @returns {ILedgerNormalizeResult}
 */
export const normalizeLedgerEntries = (
  entries: ILedgerEntry[],
  accountTypes: Map<number, string>,
): ILedgerNormalizeResult => {
  const groups = new Map<string, number[]>();

  entries.forEach((entry, index) => {
    const key = groupKey(entry);
    groups.set(key, [...(groups.get(key) || []), index]);
  });
  const normalized = [...entries];
  const unbalanced: ILedgerUnbalancedGroup[] = [];

  groups.forEach((indexes) => {
    const groupEntries = indexes.map((index) => entries[index]);

    if (groupEntries.some((entry) => Boolean(entry.entryId))) {
      return;
    }
    const typeOf = (entry: ILedgerEntry) => accountTypes.get(entry.accountId);
    const maxLeftoverCents = groupEntries.length;

    // The largest income/expense line, else any line but A/R, A/P and bank,
    // else the largest line.
    const pickers = [
      (entry: ILedgerEntry) => PLUG_ACCOUNT_TYPES.includes(typeOf(entry)),
      (entry: ILedgerEntry) =>
        !NEVER_PLUG_ACCOUNT_TYPES.includes(typeOf(entry)),
      () => true,
    ];
    let result = balanceEntries(groupEntries, {
      canAbsorb: pickers[0],
      maxLeftoverCents,
    });
    for (let i = 1; !result.balanced && i < pickers.length; i += 1) {
      if (Math.abs(result.leftoverCents) > maxLeftoverCents) break;
      result = balanceEntries(groupEntries, {
        canAbsorb: pickers[i],
        maxLeftoverCents,
      });
    }
    if (!result.balanced) {
      const [first] = groupEntries;
      unbalanced.push({
        transactionType: first.transactionType,
        transactionId: first.transactionId,
        basis: first.basis ?? null,
        leftoverCents: result.leftoverCents,
      });
    }
    indexes.forEach((index, position) => {
      normalized[index] = result.entries[position];
    });
  });
  return { entries: normalized, unbalanced };
};

/**
 * Whether the strict ledger mode is on (tests): an unbalanced set throws
 * instead of only logging a warning.
 * @returns {boolean}
 */
export const isLedgerStrictMode = () =>
  ['1', 'true', 'yes'].includes(
    String(process.env.LEDGER_STRICT_MODE || '').toLowerCase(),
  );

/**
 * Formats an unbalanced group for logs and errors.
 * @param {ILedgerUnbalancedGroup} group
 * @returns {string}
 */
export const formatUnbalancedGroup = (group: ILedgerUnbalancedGroup) =>
  `${group.transactionType} #${group.transactionId} [${group.basis ?? 'general'}] ` +
  `debits - credits = ${fromCents(group.leftoverCents)}`;

/**
 * Records a strict mode violation on the global object, so a test run can
 * fail on it even when the error is swallowed by an event handler.
 * @param {string} message
 */
export const recordLedgerStrictViolation = (message: string) => {
  const store = globalThis as { __ledgerStrictViolations?: string[] };
  store.__ledgerStrictViolations = [
    ...(store.__ledgerStrictViolations || []),
    message,
  ];
};
