import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import * as moment from 'moment';
import { BaseLandedCostService } from '../BaseLandedCost.service';
import { BillLandedCost } from '../models/BillLandedCost';
import { Bill } from '@/modules/Bills/models/Bill';
import { BillLandedCostEntry } from '../models/BillLandedCostEntry';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { BillPaymentEntry } from '@/modules/BillPayments/models/BillPaymentEntry';
import {
  allocateCumulativeShare,
  roundMoney,
  subtractMoney,
  sumMoney,
} from '@bigcapital/utils';

/**
 * A payment of the bill a landed cost comes from (bill currency).
 */
export interface ILandedCostSourcePayment {
  date: Date | string;
  amount: number;
}

@Injectable()
export class LandedCostGLEntriesService extends BaseLandedCostService {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,

    @Inject(BillLandedCost.name)
    protected readonly billLandedCostModel: TenantModelProxy<
      typeof BillLandedCost
    >,

    @Inject(BillPaymentEntry.name)
    private readonly billPaymentEntryModel?: TenantModelProxy<
      typeof BillPaymentEntry
    >,
  ) {
    super();
  }

  /**
   * Whether the landed cost comes from a bill (and not an expense).
   * @param {BillLandedCost} allocatedLandedCost
   */
  private isFromBill(allocatedLandedCost: BillLandedCost): boolean {
    return allocatedLandedCost.fromTransactionType === 'Bill';
  }

  /**
   * Retrieves the landed cost GL common entry.
   */
  private getLandedCostGLCommonEntry(
    bill: Bill,
    allocatedLandedCost: BillLandedCost,
  ) {
    return {
      date: moment(bill.billDate).format('YYYY-MM-DD'),
      currencyCode: allocatedLandedCost.currencyCode,
      exchangeRate: allocatedLandedCost.exchangeRate,

      transactionType: 'LandedCost',
      transactionId: allocatedLandedCost.id,
      transactionNumber: bill.billNumber,

      referenceNumber: bill.referenceNo,

      branchId: bill.branchId,
      projectId: bill.projectId,

      // A landed cost from a bill is an accrual like the bill: on the cash
      // basis it follows the bill's payments (see the cash entries). One
      // from an expense is paid already, so it counts on both bases.
      ...(this.isFromBill(allocatedLandedCost)
        ? { basis: AccountingBasis.Accrual }
        : {}),

      credit: 0,
      debit: 0,
    };
  }

  /**
   * Retrieves the account an allocated entry's cost goes to: the item's
   * inventory account, or the line cost account for a non-inventory item.
   */
  private getAllocatedEntryAccountId(
    allocatedEntry: BillLandedCostEntry,
  ): number {
    const itemEntry = (
      allocatedEntry as BillLandedCostEntry & {
        itemEntry?: {
          item?: { type?: string; inventoryAccountId?: number };
          costAccountId?: number;
        };
      }
    ).itemEntry;
    const item = itemEntry?.item;
    const isInventory = item && ['inventory'].indexOf(item.type) !== -1;
    const accountId = isInventory
      ? item?.inventoryAccountId
      : itemEntry?.costAccountId;

    if (!accountId) {
      throw new Error(
        `Cannot determine GL account for landed cost allocate entry (entryId: ${allocatedEntry.entryId})`,
      );
    }
    return accountId;
  }

  /**
   * Retrieves the landed cost GL inventory entry for an allocated item.
   */
  private getLandedCostGLInventoryEntry(
    bill: Bill,
    allocatedLandedCost: BillLandedCost,
    allocatedEntry: BillLandedCostEntry,
    index: number,
  ): ILedgerEntry {
    const commonEntry = this.getLandedCostGLCommonEntry(
      bill,
      allocatedLandedCost,
    );
    const accountId = this.getAllocatedEntryAccountId(allocatedEntry);
    const itemEntry = (
      allocatedEntry as BillLandedCostEntry & {
        itemEntry?: {
          item?: { type?: string; inventoryAccountId?: number };
          costAccountId?: number;
          itemId?: number;
        };
      }
    ).itemEntry;
    const localAmount =
      allocatedEntry.cost * (allocatedLandedCost.exchangeRate || 1);

    return {
      ...commonEntry,
      debit: localAmount,
      foreignDebit: allocatedEntry.cost,
      accountId,
      index: index + 1,
      indexGroup: 10,
      itemId: itemEntry?.itemId,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the landed cost GL cost entry (credit to cost account).
   */
  private getLandedCostGLCostEntry(
    bill: Bill,
    allocatedLandedCost: BillLandedCost,
  ): ILedgerEntry {
    const commonEntry = this.getLandedCostGLCommonEntry(
      bill,
      allocatedLandedCost,
    );

    return {
      ...commonEntry,
      credit: allocatedLandedCost.localAmount,
      foreignCredit: allocatedLandedCost.amount,
      accountId: allocatedLandedCost.costAccountId,
      index: 1,
      indexGroup: 20,
      accountNormal: AccountNormal.CREDIT,
    };
  }

  /**
   * Composes the landed cost GL entries.
   */
  public getLandedCostGLEntries(
    allocatedLandedCost: BillLandedCost,
    bill: Bill,
  ): ILedgerEntry[] {
    const inventoryEntries = allocatedLandedCost.allocateEntries.map(
      (allocatedEntry, index) =>
        this.getLandedCostGLInventoryEntry(
          bill,
          allocatedLandedCost,
          allocatedEntry,
          index,
        ),
    );
    const costEntry = this.getLandedCostGLCostEntry(bill, allocatedLandedCost);

    return [...inventoryEntries, costEntry];
  }

  /**
   * Retrieves the landed cost GL ledger.
   */
  public getLandedCostLedger(
    allocatedLandedCost: BillLandedCost,
    bill: Bill,
  ): Ledger {
    const entries = this.getLandedCostGLEntries(allocatedLandedCost, bill);
    return new Ledger(entries);
  }

  /**
   * Generates and writes GL entries of the given landed cost.
   */
  public createLandedCostGLEntries = async (
    billLandedCostId: number,
    trx?: Knex.Transaction,
  ) => {
    const allocatedLandedCost = await this.billLandedCostModel()
      .query(trx)
      .findById(billLandedCostId)
      .withGraphFetched('bill')
      .withGraphFetched('allocateEntries.itemEntry.item');

    if (!allocatedLandedCost?.bill) {
      throw new Error('BillLandedCost or associated Bill not found');
    }

    const ledger = this.getLandedCostLedger(
      allocatedLandedCost,
      allocatedLandedCost.bill,
    );
    await this.ledgerStorage.commit(ledger, trx);

    // On the cash basis a landed cost from a bill follows its payments.
    await this.writeLandedCostCashGLEntries(allocatedLandedCost, trx);
  };

  /**
   * Retrieves the cash basis entries of a landed cost from a bill: each
   * payment of that bill moves its share of the landed cost from the cost
   * account into stock, at the payment date, so on the cash basis the cost
   * only moves once the money has left. The shares are a running total, so
   * once the bill is fully paid each line ends exactly at its accrual
   * amount.
   * -----
   * - Inventory -> Debit -> paid share
   *    - Cost account -> Credit -> paid share
   * -----
   * @param {BillLandedCost} allocatedLandedCost - With `allocateEntries.itemEntry.item`.
   * @param {Bill} bill - The bill the cost is allocated to.
   * @param {number} sourceBillTotal - Total of the bill the cost comes from.
   * @param {ILandedCostSourcePayment[]} payments - Its payments, in order.
   * @returns {ILedgerEntry[]}
   */
  public getLandedCostCashGLEntries(
    allocatedLandedCost: BillLandedCost,
    bill: Bill,
    sourceBillTotal: number,
    payments: ILandedCostSourcePayment[],
  ): ILedgerEntry[] {
    if (!this.isFromBill(allocatedLandedCost)) return [];

    const rate = allocatedLandedCost.exchangeRate || 1;
    const allocateEntries = allocatedLandedCost.allocateEntries || [];
    const lines = allocateEntries.map((entry) => roundMoney(entry.cost * rate));
    const accounts = allocateEntries.map((entry) =>
      this.getAllocatedEntryAccountId(entry),
    );
    const entries: ILedgerEntry[] = [];
    let paidBefore = 0;

    payments.forEach((payment) => {
      const left = Math.max(subtractMoney(sourceBillTotal, paidBefore), 0);
      const amount = Math.min(roundMoney(payment.amount), left);
      if (amount <= 0) return;

      const parts = allocateCumulativeShare(
        paidBefore,
        amount,
        sourceBillTotal,
        lines,
      );
      paidBefore = sumMoney(paidBefore, amount);

      const common = {
        ...this.getLandedCostGLCommonEntry(bill, allocatedLandedCost),
        date: moment(payment.date).format('YYYY-MM-DD'),
        basis: AccountingBasis.Cash,
      };
      const debits = parts
        .map((part, index) => ({ part, index }))
        .filter(({ part }) => part !== 0)
        .map(({ part, index }) => ({
          ...common,
          debit: part,
          accountId: accounts[index],
          index: index + 1,
          indexGroup: 10,
          itemId: (allocateEntries[index] as any).itemEntry?.itemId,
          accountNormal: AccountNormal.DEBIT,
        }));
      if (debits.length === 0) return;

      entries.push(...debits, {
        ...common,
        credit: sumMoney(...parts),
        accountId: allocatedLandedCost.costAccountId,
        index: 1,
        indexGroup: 20,
        accountNormal: AccountNormal.CREDIT,
      });
    });
    return entries;
  }

  /**
   * Writes the cash basis entries of the given landed cost from the
   * payments of the bill it comes from.
   * @param {BillLandedCost} allocatedLandedCost - With `bill` and
   *   `allocateEntries.itemEntry.item` fetched.
   * @param {Knex.Transaction} trx
   */
  private writeLandedCostCashGLEntries = async (
    allocatedLandedCost: BillLandedCost,
    trx?: Knex.Transaction,
  ) => {
    if (!this.isFromBill(allocatedLandedCost) || !this.billPaymentEntryModel) {
      return;
    }
    const paymentEntries = await this.billPaymentEntryModel()
      .query(trx)
      .where('billId', allocatedLandedCost.fromTransactionId)
      .withGraphFetched('payment')
      .withGraphFetched('bill');

    if (paymentEntries.length === 0) return;

    const payments = paymentEntries
      .filter((entry) => entry.payment)
      .map((entry) => ({
        date: entry.payment.paymentDate,
        amount: entry.paymentAmount,
        paymentId: entry.payment.id,
      }))
      .sort(
        (a, b) =>
          moment(a.date).diff(moment(b.date)) || a.paymentId - b.paymentId,
      );
    const entries = this.getLandedCostCashGLEntries(
      allocatedLandedCost,
      allocatedLandedCost.bill,
      paymentEntries[0].bill.total,
      payments,
    );
    if (entries.length === 0) return;

    await this.ledgerStorage.commit(new Ledger(entries), trx);
  };

  /**
   * Rewrites the cash basis entries of the landed costs that come from the
   * given bills, once their payments (or the bills) change.
   * @param {number[]} billsIds - The bills the landed costs come from.
   * @param {Knex.Transaction} trx
   */
  public rewriteLandedCostsCashGLEntriesOfSourceBills = async (
    billsIds: number[],
    trx?: Knex.Transaction,
  ) => {
    const ids = [...new Set(billsIds.filter(Boolean))];
    if (ids.length === 0) return;

    const landedCosts = await this.billLandedCostModel()
      .query(trx)
      .where('fromTransactionType', 'Bill')
      .whereIn('fromTransactionId', ids)
      .withGraphFetched('bill')
      .withGraphFetched('allocateEntries.itemEntry.item');

    for (const landedCost of landedCosts) {
      await this.ledgerStorage.deleteByReference(
        landedCost.id,
        'LandedCost',
        trx,
        { basis: AccountingBasis.Cash },
      );
      await this.writeLandedCostCashGLEntries(landedCost, trx);
    }
  };

  /**
   * Reverts GL entries of the given allocated landed cost transaction.
   */
  public revertLandedCostGLEntries = async (
    landedCostId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(landedCostId, 'LandedCost', trx);
  };
}
