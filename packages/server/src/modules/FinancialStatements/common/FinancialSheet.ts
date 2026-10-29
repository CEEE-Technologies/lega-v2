import { roundHalfAwayFromZero, subtractMoney } from '@bigcapital/utils';
import * as moment from 'moment';
import {
  IFormatNumberSettings,
  INumberFormatQuery,
} from '../types/Report.types';
import { formatNumber } from '@/utils/format-number';
import { IFinancialTableTotal } from '../types/Table.types';

export class FinancialSheet {
  public numberFormat: INumberFormatQuery = {
    precision: 2,
    divideOn1000: false,
    showZero: false,
    formatMoney: 'total',
    negativeFormat: 'mines',
  };
  public baseCurrency: string;
  public dateFormat: string = 'YYYY MMM DD';

  /**
   * Transformes the number format query to settings
   */
  protected transfromFormatQueryToSettings(): IFormatNumberSettings {
    const { numberFormat } = this;

    return {
      precision: numberFormat.precision,
      divideOn1000: numberFormat.divideOn1000,
      excerptZero: !numberFormat.showZero,
      negativeFormat: numberFormat.negativeFormat,
      money: numberFormat.formatMoney === 'always',
      currencyCode: this.baseCurrency,
    };
  }

  /**
   * Formating amount based on the given report query.
   * @param  {number} number -
   * @param  {IFormatNumberSettings} overrideSettings -
   * @return {string}
   */
  protected formatNumber(
    number,
    overrideSettings: IFormatNumberSettings = {},
  ): string {
    const settings = {
      ...this.transfromFormatQueryToSettings(),
      ...overrideSettings,
    };
    return formatNumber(number, settings);
  }

  /**
   * Formatting full amount with different format settings.
   * @param {number} amount -
   * @param {IFormatNumberSettings} settings -
   */
  protected formatTotalNumber = (
    amount: number,
    settings: IFormatNumberSettings = {},
  ): string => {
    const { numberFormat } = this;

    return this.formatNumber(amount, {
      money: numberFormat.formatMoney === 'none' ? false : true,
      excerptZero: false,
      ...settings,
    });
  };

  /**
   * Formates the amount to the percentage string.
   * @param   {number} amount
   * @returns {string}
   */
  protected formatPercentage = (
    amount: number,
    overrideSettings: IFormatNumberSettings = {},
  ): string => {
    const percentage = roundHalfAwayFromZero(amount * 100, 2);
    const settings = {
      excerptZero: true,
      ...overrideSettings,
      symbol: '%',
      money: false,
    };
    return formatNumber(percentage, settings);
  };

  /**
   * Format the given total percentage.
   * @param {number} amount -
   * @param {IFormatNumberSettings} settings -
   */
  protected formatTotalPercentage = (
    amount: number,
    settings: IFormatNumberSettings = {},
  ): string => {
    return this.formatPercentage(amount, {
      ...settings,
      excerptZero: false,
    });
  };

  /**
   * Retrieve the amount meta object.
   * @param {number} amount
   * @returns {ICashFlowStatementTotal}
   */
  protected getAmountMeta(
    amount: number,
    overrideSettings?: IFormatNumberSettings,
  ): IFinancialTableTotal {
    return {
      amount,
      formattedAmount: this.formatNumber(amount, overrideSettings),
      currencyCode: this.baseCurrency,
    };
  }

  /**
   * Retrieve the total amount meta object.
   * @param {number} amount
   * @returns {ICashFlowStatementTotal}
   */
  protected getTotalAmountMeta(
    amount: number,
    title?: string,
  ): IFinancialTableTotal {
    return {
      ...(title ? { title } : {}),
      amount,
      formattedAmount: this.formatTotalNumber(amount),
      currencyCode: this.baseCurrency,
    };
  }

  /**
   * Retrieve the date meta.
   * @param {Date} date
   * @param {string} format
   * @returns
   */
  protected getDateMeta(date: moment.MomentInput, format?: string) {
    const dateFormat = format || this.dateFormat || 'YYYY MMM DD';
    return {
      formattedDate: moment(date).format(dateFormat),
      date: moment(date).toDate(),
    };
  }

  protected getDateFormatted(date: moment.MomentInput, format?: string) {
    const dateFormat = format || this.dateFormat || 'YYYY MMM DD';
    return moment(date).format(dateFormat);
  }

  getPercentageBasis = (base, amount) => {
    return base ? amount / base : 0;
  };

  getAmountChange = (base, amount) => {
    return subtractMoney(base, amount);
  };

  /**
   * A report percentage is shown with 2 decimals (12.35%): its ratio is
   * rounded to 4 decimals, halves away from zero, so the amount and the
   * formatted text agree.
   */
  protected getPercentageAmountMeta = (amount) => {
    const rounded = roundHalfAwayFromZero(amount, 4);
    const formattedAmount = this.formatPercentage(rounded);

    return {
      amount: rounded,
      formattedAmount,
    };
  };

  /**
   * Re
   * @param {number} amount
   * @returns
   */
  protected getPercentageTotalAmountMeta = (amount: number) => {
    const rounded = roundHalfAwayFromZero(amount, 4);
    const formattedAmount = this.formatTotalPercentage(rounded);

    return { amount: rounded, formattedAmount };
  };
}
