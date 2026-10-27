import * as Yup from 'yup';
import { moneyLte } from '@bigcapital/utils';

/**
 * A nullable money number no more than the sibling field `maxField`,
 * compared in whole cents (so 1.10 + 2.20 can pay a due of 3.30).
 * @param {string} maxField - Sibling field holding the maximum.
 */
export const moneyAtMostSibling = (maxField: string) =>
  Yup.number()
    .nullable()
    .test(
      'money-max',
      // Same wording as Yup's own max().
      '${path} must be less than or equal to ${max}',
      function (value) {
        const max = this.parent?.[maxField];
        if (value === null || value === undefined) return true;
        if (max === null || max === undefined || max === '') return true;

        return moneyLte(value, max) || this.createError({ params: { max } });
      },
    );
