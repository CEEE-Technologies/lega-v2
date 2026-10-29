import { defaultTo } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { PaymentReceived } from '../models/PaymentReceived';
import { PaymentReceivedEntry } from '../models/PaymentReceivedEntry';
import { increment } from '@/utils/increment';
import {
  allocateCumulativeShare,
  moneyGt,
  roundMoney,
  subtractMoney,
} from '@bigcapital/utils';
import { creditSide, debitSide } from '@/utils/ledger-rounding';

/**
 * Aggregated cost of a single invoice item retrieved from the inventory
 * cost lots of the sale invoice.
 */
export interface IInvoiceItemCost {
  itemId: number;
  cost: number;
  costAccountId: number;
  inventoryAccountId: number;
  description?: string | null;
}

/**
 * Records the cash basis cost (COGS) journal entries of the payment received.
 * The cash basis recognizes the cost of goods sold of the associated
 * invoice(s) once the payment is received instead of the invoice date.
 *
 * The entries mirror the cost composition of the invoice (the cost of goods
 * sold accounts and the inventory accounts) scaled by the paid proportion
 * of the invoice.
 */
export class PaymentReceivedCostCashGL {
  private readonly paymentReceived: PaymentReceived;
  private invoicesItemCosts: Record<number, IInvoiceItemCost[]> = {};

  /**
   * Amount paid on each invoice by the earlier payments (invoice currency).
   */
  private paidBefore: Record<number, number> = {};

  /**
   * Sets the amount paid on each invoice by the earlier payments.
   * @param {Record<number, number>} paidBefore - By invoice id.
   * @returns {PaymentReceivedCostCashGL}
   */
  setPaidBefore(paidBefore: Record<number, number>) {
    this.paidBefore = paidBefore ?? {};
    return this;
  }

  /**
   * Constructor method.
   * @param {PaymentReceived} paymentReceived - Payment received.
   */
  constructor(paymentReceived: PaymentReceived) {
    this.paymentReceived = paymentReceived;
  }

  /**
   * Sets the aggregated item costs of the associated invoices.
   * @param {Record<number, IInvoiceItemCost[]>} invoicesItemCosts
   * @returns {PaymentReceivedCostCashGL}
   */
  setInvoicesItemCosts(invoicesItemCosts: Record<number, IInvoiceItemCost[]>) {
    this.invoicesItemCosts = invoicesItemCosts ?? {};
    return this;
  }

  /**
   * Retrieves the common journal entry of the cash basis cost entries.
   */
  private get costEntriesCommonEntry() {
    return {
      credit: 0,
      debit: 0,

      currencyCode: this.paymentReceived.currencyCode,
      exchangeRate: this.paymentReceived.exchangeRate,

      transactionId: this.paymentReceived.id,
      transactionType: 'PaymentReceive',

      transactionNumber: this.paymentReceived.paymentReceiveNo,
      referenceNumber: this.paymentReceived.referenceNo,

      date: this.paymentReceived.paymentDate,
      userId: this.paymentReceived.userId,
      createdAt: this.paymentReceived.createdAt,

      branchId: this.paymentReceived.branchId,

      indexGroup: 60,
      basis: AccountingBasis.Cash,
      costable: true,
    };
  }

  /**
   * Retrieves the part of the payment entry that pays the invoice (invoice
   * currency): no more than what the earlier payments left to pay.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {number}
   */
  private getPaymentEntryRecognizedAmount = (
    entry: PaymentReceivedEntry,
  ): number => {
    const remaining = Math.max(
      subtractMoney(
        defaultTo(entry.invoice?.total, 0),
        this.paidBefore[entry.invoiceId] || 0,
      ),
      0,
    );
    return Math.min(roundMoney(entry.paymentAmount), remaining);
  };

  /**
   * Retrieves the cash basis cost entries of the given payment entry: the
   * invoice item costs recognized with the running-total method (the cost
   * recognized after this payment minus the cost recognized before it), so
   * once the invoice is fully paid every cost line ends exactly at its cost.
   * -----
   * - Cost of goods sold -> Debit -> cost part
   *    - Inventory -> Credit -> cost part
   * -----
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryCostEntries = (
    entry: PaymentReceivedEntry,
  ): ILedgerEntry[] => {
    const invoice = entry.invoice;
    const itemCosts = this.invoicesItemCosts[entry.invoiceId] || [];
    const recognized = this.getPaymentEntryRecognizedAmount(entry);

    if (!invoice || !moneyGt(recognized, 0) || itemCosts.length === 0) {
      return [];
    }
    const costs = allocateCumulativeShare(
      this.paidBefore[entry.invoiceId] || 0,
      recognized,
      invoice.total,
      itemCosts.map((itemCost) => itemCost.cost),
    );
    const commonEntry = this.costEntriesCommonEntry;
    const getIndexIncrement = increment(0);

    return itemCosts.flatMap((itemCost, index) => {
      // Both sides share the same amount, so the pair balances.
      const cost = costs[index];

      // XXX Debit - Cost account.
      const costEntry = {
        ...commonEntry,
        ...debitSide(cost),
        accountId: itemCost.costAccountId,
        accountNormal: AccountNormal.DEBIT,
        itemId: itemCost.itemId,
        note: itemCost.description || null,
        index: getIndexIncrement(),
      };
      // XXX Credit - Inventory account.
      const inventoryEntry = {
        ...commonEntry,
        ...creditSide(cost),
        accountId: itemCost.inventoryAccountId,
        accountNormal: AccountNormal.DEBIT,
        itemId: itemCost.itemId,
        note: itemCost.description || null,
        index: getIndexIncrement(),
      };
      return [costEntry, inventoryEntry];
    });
  };

  /**
   * Retrieves the payment received cash basis cost GL entries.
   * @returns {ILedgerEntry[]}
   */
  public GLEntries(): ILedgerEntry[] {
    return (this.paymentReceived.entries || []).flatMap(
      this.getPaymentEntryCostEntries,
    );
  }

  /**
   * Retrieves the payment received cash basis cost ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
