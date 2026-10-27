import { Knex } from 'knex';
import { ACCOUNT_TYPE } from '@/constants/accounts';

/**
 * Amount difference under which two ledger totals are considered equal
 * (the ledger stores 3 decimals).
 */
const EPSILON = 0.0005;

export interface ICashBasisAccountDifference {
  accountId: number;
  accountName: string;
  cashBalance: number;
  accrualBalance: number;
  difference: number;
}

export interface ICashBasisUnbalancedSet {
  referenceType: string;
  referenceId: number;
  basis: string | null;
  debit: number;
  credit: number;
  difference: number;
}

/**
 * A contact whose stored paid opening balance doesn't match its payments'
 * opening balance lines (or is more than the opening balance).
 */
export interface IOpeningBalancePaidMismatch {
  contactId: number;
  displayName: string;
  openingBalance: number;
  storedPaidAmount: number;
  entriesPaidAmount: number;
}

/**
 * A contact with an unpaid opening balance and unapplied payment credit:
 * the accountant can apply the credit by editing those payments.
 */
export interface IOpeningBalanceCreditCandidate {
  contactId: number;
  contactService: string;
  displayName: string;
  openingBalanceDue: number;
  unappliedAmount: number;
  payments: string;
}

export interface ICashBasisCheckResult {
  accountDifferences: ICashBasisAccountDifference[];
  unbalancedSets: ICashBasisUnbalancedSet[];
  openingBalancePaidMismatches?: IOpeningBalancePaidMismatch[];
  openingBalanceCreditCandidates?: IOpeningBalanceCreditCandidate[];
}

const round3 = (value: any) => Math.round(Number(value || 0) * 1000) / 1000;

/**
 * Checks the cash basis ledger of a tenant database:
 * - every bank and cash account has the same balance on both bases (cash
 *   moves the same way whatever the basis), and
 * - every entry set (reference + basis) balances.
 *
 * Plain queries on the given tenant connection, so the CLI can run it
 * without the application context.
 * @param {Knex} knex - Tenant database connection.
 * @returns {Promise<ICashBasisCheckResult>}
 */
export const checkCashBasis = async (
  knex: Knex,
): Promise<ICashBasisCheckResult> => {
  const signedAmount = '?? - ??';
  const amountBindings = ['transactions.debit', 'transactions.credit'];

  const accountRows: any[] = await knex
    .queryBuilder()
    .from('accounts')
    .leftJoin(
      'accounts_transactions as transactions',
      'transactions.account_id',
      'accounts.id',
    )
    .whereIn('accounts.account_type', [ACCOUNT_TYPE.BANK, ACCOUNT_TYPE.CASH])
    .groupBy('accounts.id', 'accounts.name')
    .select('accounts.id as accountId', 'accounts.name as accountName')
    .select(
      knex.raw(
        `COALESCE(SUM(CASE WHEN ?? = 'cash' OR ?? IS NULL THEN ${signedAmount} ELSE 0 END), 0) as ??`,
        [
          'transactions.basis',
          'transactions.basis',
          ...amountBindings,
          'cashBalance',
        ],
      ),
      knex.raw(
        `COALESCE(SUM(CASE WHEN ?? = 'accrual' OR ?? IS NULL THEN ${signedAmount} ELSE 0 END), 0) as ??`,
        [
          'transactions.basis',
          'transactions.basis',
          ...amountBindings,
          'accrualBalance',
        ],
      ),
    );

  const accountDifferences = accountRows
    .map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      cashBalance: round3(row.cashBalance),
      accrualBalance: round3(row.accrualBalance),
      difference: round3(row.cashBalance - row.accrualBalance),
    }))
    .filter((row) => Math.abs(row.difference) > EPSILON);

  const setRows: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions')
    .groupBy('reference_type', 'reference_id', 'basis')
    .select('reference_type as referenceType', 'reference_id as referenceId')
    .select('basis')
    .sum('debit as debit')
    .sum('credit as credit')
    .havingRaw('ABS(SUM(??) - SUM(??)) > ?', ['debit', 'credit', EPSILON])
    .orderBy(['reference_type', 'reference_id']);

  const unbalancedSets = setRows.map((row) => ({
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    basis: row.basis ?? null,
    debit: round3(row.debit),
    credit: round3(row.credit),
    difference: round3(row.debit - row.credit),
  }));

  const openingBalancePaidMismatches =
    await getOpeningBalancePaidMismatches(knex);
  const openingBalanceCreditCandidates =
    await getOpeningBalanceCreditCandidates(knex);

  return {
    accountDifferences,
    unbalancedSets,
    openingBalancePaidMismatches,
    openingBalanceCreditCandidates,
  };
};

/**
 * Payments of each kind: the table names and the contact column.
 */
const PAYMENT_KINDS = [
  {
    contactService: 'customer',
    paymentsTable: 'payment_receives',
    entriesTable: 'payment_receives_entries',
    entryPaymentId: 'payment_receive_id',
    contactColumn: 'customer_id',
    numberColumn: 'payment_receive_no',
  },
  {
    contactService: 'vendor',
    paymentsTable: 'bills_payments',
    entriesTable: 'bills_payments_entries',
    entryPaymentId: 'bill_payment_id',
    contactColumn: 'vendor_id',
    numberColumn: 'payment_number',
  },
];

/**
 * Retrieves the contacts whose stored paid opening balance differs from the
 * sum of their payments' opening balance lines, or exceeds the opening
 * balance.
 * @param {Knex} knex
 * @returns {Promise<IOpeningBalancePaidMismatch[]>}
 */
const getOpeningBalancePaidMismatches = async (
  knex: Knex,
): Promise<IOpeningBalancePaidMismatch[]> => {
  const paidByContact = new Map<number, number>();

  for (const kind of PAYMENT_KINDS) {
    const rows: any[] = await knex
      .queryBuilder()
      .from(`${kind.entriesTable} as entries`)
      .join(
        `${kind.paymentsTable} as payments`,
        'payments.id',
        `entries.${kind.entryPaymentId}`,
      )
      .where('entries.entry_type', 'opening_balance')
      .groupBy(`payments.${kind.contactColumn}`)
      .select(`payments.${kind.contactColumn} as contactId`)
      .sum('entries.payment_amount as paidAmount');

    rows.forEach((row) => {
      paidByContact.set(
        row.contactId,
        round3(
          (paidByContact.get(row.contactId) || 0) + Number(row.paidAmount),
        ),
      );
    });
  }
  const contacts: any[] = await knex
    .queryBuilder()
    .from('contacts')
    .where((builder) => {
      builder.where('opening_balance_payment_amount', '<>', 0);

      if (paidByContact.size > 0) {
        builder.orWhereIn('id', [...paidByContact.keys()]);
      }
    })
    .select(
      'id as contactId',
      'display_name as displayName',
      'opening_balance as openingBalance',
      'opening_balance_payment_amount as storedPaidAmount',
    );

  return contacts
    .map((contact) => ({
      contactId: contact.contactId,
      displayName: contact.displayName,
      openingBalance: round3(contact.openingBalance),
      storedPaidAmount: round3(contact.storedPaidAmount),
      entriesPaidAmount: paidByContact.get(contact.contactId) || 0,
    }))
    .filter(
      (row) =>
        Math.abs(row.storedPaidAmount - row.entriesPaidAmount) > EPSILON ||
        row.storedPaidAmount - row.openingBalance > EPSILON,
    );
};

/**
 * Retrieves the contacts with an unpaid opening balance and payments with
 * an unapplied amount (payment amount more than its lines).
 * @param {Knex} knex
 * @returns {Promise<IOpeningBalanceCreditCandidate[]>}
 */
const getOpeningBalanceCreditCandidates = async (
  knex: Knex,
): Promise<IOpeningBalanceCreditCandidate[]> => {
  const candidates: IOpeningBalanceCreditCandidate[] = [];

  for (const kind of PAYMENT_KINDS) {
    const applied = knex
      .queryBuilder()
      .from(kind.entriesTable)
      .groupBy(kind.entryPaymentId)
      .select(`${kind.entryPaymentId} as paymentId`)
      .sum('payment_amount as appliedAmount');

    const rows: any[] = await knex
      .queryBuilder()
      .from(`${kind.paymentsTable} as payments`)
      .join('contacts', 'contacts.id', `payments.${kind.contactColumn}`)
      .leftJoin(applied.as('applied'), 'applied.paymentId', 'payments.id')
      .where('contacts.contact_service', kind.contactService)
      .whereRaw('?? - COALESCE(??, 0) > ?', [
        'contacts.opening_balance',
        'contacts.opening_balance_payment_amount',
        EPSILON,
      ])
      .whereRaw('?? - COALESCE(??, 0) > ?', [
        'payments.amount',
        'applied.appliedAmount',
        EPSILON,
      ])
      .select(
        'contacts.id as contactId',
        'contacts.display_name as displayName',
        'contacts.opening_balance as openingBalance',
        'contacts.opening_balance_payment_amount as openingBalancePaid',
        `payments.${kind.numberColumn} as paymentNumber`,
        'payments.id as paymentId',
        knex.raw('?? - COALESCE(??, 0) as ??', [
          'payments.amount',
          'applied.appliedAmount',
          'unappliedAmount',
        ]),
      )
      .orderBy(['contacts.id', 'payments.id']);

    const byContact = new Map<number, IOpeningBalanceCreditCandidate>();

    rows.forEach((row) => {
      const candidate = byContact.get(row.contactId) || {
        contactId: row.contactId,
        contactService: kind.contactService,
        displayName: row.displayName,
        openingBalanceDue: round3(row.openingBalance - row.openingBalancePaid),
        unappliedAmount: 0,
        payments: '',
      };
      candidate.unappliedAmount = round3(
        candidate.unappliedAmount + Number(row.unappliedAmount),
      );
      const label = `${row.paymentNumber || `#${row.paymentId}`} (${round3(row.unappliedAmount)})`;
      candidate.payments = candidate.payments
        ? `${candidate.payments}, ${label}`
        : label;
      byContact.set(row.contactId, candidate);
    });
    candidates.push(...byContact.values());
  }
  return candidates;
};

/**
 * Formats the check result as printable lines.
 * @param {ICashBasisCheckResult} result
 * @returns {string[]}
 */
export const formatCashBasisCheck = (result: ICashBasisCheckResult) => {
  const lines: string[] = [];

  if (result.accountDifferences.length === 0) {
    lines.push('  Bank/cash accounts: cash and accrual totals match.');
  } else {
    lines.push(
      '  Bank/cash accounts where the cash and accrual totals differ:',
    );
    result.accountDifferences.forEach((row) => {
      lines.push(
        `    #${row.accountId} ${row.accountName}: cash ${row.cashBalance}, accrual ${row.accrualBalance} (diff ${row.difference})`,
      );
    });
  }
  if (result.unbalancedSets.length === 0) {
    lines.push('  Entry sets: all balanced.');
  } else {
    lines.push('  Unbalanced entry sets:');
    result.unbalancedSets.forEach((row) => {
      lines.push(
        `    ${row.referenceType} #${row.referenceId} [${row.basis ?? 'general'}]: debit ${row.debit}, credit ${row.credit} (diff ${row.difference})`,
      );
    });
  }
  const mismatches = result.openingBalancePaidMismatches || [];

  if (mismatches.length === 0) {
    lines.push('  Paid opening balances: match the payment lines.');
  } else {
    lines.push(
      '  Contacts whose paid opening balance differs from their payment lines:',
    );
    mismatches.forEach((row) => {
      lines.push(
        `    #${row.contactId} ${row.displayName}: opening balance ${row.openingBalance}, stored paid ${row.storedPaidAmount}, payment lines ${row.entriesPaidAmount}`,
      );
    });
  }
  const candidates = result.openingBalanceCreditCandidates || [];

  if (candidates.length > 0) {
    lines.push(
      '  For review (not an error): contacts with an unpaid opening balance and unapplied payment credit.',
    );
    lines.push(
      '  To use the credit for the opening balance, edit those payments and fill the "Opening balance" line:',
    );
    candidates.forEach((row) => {
      lines.push(
        `    ${row.contactService} #${row.contactId} ${row.displayName}: opening balance due ${row.openingBalanceDue}, unapplied ${row.unappliedAmount} on ${row.payments}`,
      );
    });
  }
  return lines;
};

/**
 * Determines whether the check found no problem.
 * @param {ICashBasisCheckResult} result
 * @returns {boolean}
 */
export const isCashBasisCheckClean = (result: ICashBasisCheckResult) =>
  result.accountDifferences.length === 0 &&
  result.unbalancedSets.length === 0 &&
  (result.openingBalancePaidMismatches || []).length === 0;
