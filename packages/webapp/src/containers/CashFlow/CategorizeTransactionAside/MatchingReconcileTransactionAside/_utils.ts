import { MatchingReconcileTransactionValues } from './_types';
import type { CreateCashflowTransactionBody } from '@bigcapital/sdk-ts';

const toNumber = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value) || 0;

export const transformToReq = (
  values: MatchingReconcileTransactionValues,
  bankAccountId: number,
): CreateCashflowTransactionBody => {
  return {
    date: values.date,
    referenceNo: values.referenceNo,
    transactionType:
      values.type === 'deposit' ? 'other_income' : 'other_expense',
    description: values.memo,
    amount: toNumber(values.amount),
    // Required (and checked) for a foreign-currency bank account; the
    // server uses 1 for a base-currency one. It used to always send 1.
    // (The SDK body type still marks it required, from the old default 1.)
    exchangeRate: (Number(values.exchangeRate) || undefined) as number,
    creditAccountId: toNumber(values.category),
    cashflowAccountId: bankAccountId,
    publish: true,
    branchId: values.branchId ? toNumber(values.branchId) : undefined,
  };
};

export const initialValues: MatchingReconcileTransactionValues = {
  type: 'deposit',
  date: '',
  amount: '',
  memo: '',
  referenceNo: '',
  category: '',
  branchId: '',
  exchangeRate: 1,
};
