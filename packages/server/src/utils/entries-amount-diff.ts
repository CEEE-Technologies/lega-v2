import * as _ from 'lodash';
import { moneyIsZero, subtractMoney, sumMoneyBy } from '@bigcapital/utils';

export const entriesAmountDiff = (
  newEntries,
  oldEntries,
  amountAttribute,
  idAttribute,
) => {
  const oldEntriesTable = _.chain(oldEntries)
    .groupBy(idAttribute)
    .mapValues((group) => _.sumBy(group, amountAttribute) || 0)
    .value();

  const newEntriesTable = _.chain(newEntries)
    .groupBy(idAttribute)
    .mapValues((group) => _.sumBy(group, amountAttribute) || 0)
    .mergeWith(oldEntriesTable, (objValue, srcValue) => {
      return _.isNumber(objValue) ? objValue - srcValue : srcValue * -1;
    })
    .value();

  return _.chain(newEntriesTable)
    .mapValues((value, key) => ({
      [idAttribute]: key,
      [amountAttribute]: value,
    }))
    .filter((entry) => entry[amountAttribute] != 0)
    .value();
};

/**
 * Same as `entriesAmountDiff` for money amounts: sums and differences are
 * done in whole cents, and ids whose amount didn't change to the cent are
 * left out. (Not for quantities, which keep their decimals.)
 */
export const entriesMoneyDiff = (
  newEntries,
  oldEntries,
  amountAttribute,
  idAttribute,
) => {
  const oldEntriesTable = _.chain(oldEntries)
    .groupBy(idAttribute)
    .mapValues((group) => sumMoneyBy(group, amountAttribute))
    .value();

  const newEntriesTable = _.chain(newEntries)
    .groupBy(idAttribute)
    .mapValues((group) => sumMoneyBy(group, amountAttribute))
    .mergeWith(oldEntriesTable, (objValue, srcValue) =>
      subtractMoney(_.isNumber(objValue) ? objValue : 0, srcValue),
    )
    .value();

  return _.chain(newEntriesTable)
    .mapValues((value, key) => ({
      [idAttribute]: key,
      [amountAttribute]: value,
    }))
    .filter((entry) => !moneyIsZero(entry[amountAttribute]))
    .value();
};
