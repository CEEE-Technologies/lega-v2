import {
  moneyIsZero,
  subtractMoney,
  sumMoneyBy,
  toMoneyNumber,
} from '@bigcapital/utils';
import { useFormikContext } from 'formik';
import { useMemo } from 'react';
import { useMatchingTransactionBoot } from './MatchingTransactionBoot';
import { MatchingTransactionFormValues } from './types';

export const transformToReq = (
  values: MatchingTransactionFormValues,
  uncategorizedTransactions: Array<number>,
) => {
  const matchedTransactions = Object.entries(values.matched)
    .filter(([key, value]) => value)
    .map(([key]) => {
      const [referenceType, referenceId] = key.split('-');

      return { referenceType, referenceId: parseInt(referenceId, 10) };
    });
  return { matchedTransactions, uncategorizedTransactions };
};

export const useGetPendingAmountMatched = () => {
  const { values } = useFormikContext<MatchingTransactionFormValues>();
  const { perfectMatches, possibleMatches, totalPending } =
    useMatchingTransactionBoot();

  return useMemo(() => {
    const matchedItems = [...perfectMatches, ...possibleMatches].filter(
      (match) => {
        const key = `${match.referenceType}-${match.referenceId}`;
        return values.matched[key];
      },
    );
    // Signed total in whole cents.
    const totalMatchedAmount = sumMoneyBy(matchedItems, (item) =>
      item.transactionNormal === 'debit'
        ? toMoneyNumber(item.amount)
        : -toMoneyNumber(item.amount),
    );
    return subtractMoney(totalPending, totalMatchedAmount);
  }, [totalPending, perfectMatches, possibleMatches, values]);
};

export const useAtleastOneMatchedSelected = () => {
  const { values } = useFormikContext<MatchingTransactionFormValues>();

  return useMemo(() => {
    const matchedCount = Object.values(values.matched).filter(Boolean).length;
    return matchedCount > 0;
  }, [values]);
};

export const useIsShowReconcileTransactionLink = () => {
  const pendingAmount = useGetPendingAmountMatched();
  const atleastOneSelected = useAtleastOneMatchedSelected();

  return atleastOneSelected && !moneyIsZero(pendingAmount);
};
