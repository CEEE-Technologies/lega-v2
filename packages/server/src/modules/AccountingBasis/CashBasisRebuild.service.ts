import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { PaymentReceivedGLEntries } from '@/modules/PaymentReceived/commands/PaymentReceivedGLEntries';
import { BillPaymentGLEntries } from '@/modules/BillPayments/commands/BillPaymentGLEntries';
import { RefundCreditNoteGLEntries } from '@/modules/CreditNoteRefunds/commands/RefundCreditNoteGLEntries';
import { RefundVendorCreditGLEntries } from '@/modules/VendorCreditsRefund/commands/RefundVendorCreditGLEntries';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { LandedCostGLEntriesService } from '@/modules/EE/BillLandedCosts/commands/LandedCostGLEntries.service';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import {
  CASH_BASIS_DOCUMENTS,
  CashBasisReferenceType,
  ICashBasisRebuildResult,
} from './AccountingBasis.constants';
import { checkCashBasis, ICashBasisCheckResult } from './CashBasisCheck';
import { getLockedPeriodChecker } from './MoneyHealthCheck';

/**
 * Rebuilds the cash basis entries of the current tenant from the documents.
 *
 * Each payment and refund (and each landed cost from a bill) gets its cash
 * set deleted and written again from the current document state, one
 * document per transaction, so a failure leaves the other documents done
 * and a re-run picks up where it failed. Only cash-tagged entries are
 * written (they never change the stored balances; old untagged landed cost
 * entries are only tagged accrual), so running it again gives the same
 * result.
 */
@Injectable()
export class CashBasisRebuildService {
  constructor(
    private readonly paymentReceivedGLEntries: PaymentReceivedGLEntries,
    private readonly billPaymentGLEntries: BillPaymentGLEntries,
    private readonly refundCreditNoteGLEntries: RefundCreditNoteGLEntries,
    private readonly refundVendorCreditGLEntries: RefundVendorCreditGLEntries,
    private readonly ledgerStorage: LedgerStorageService,
    private readonly landedCostGLEntries: LandedCostGLEntriesService,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Rewrites the cash set of the given document.
   */
  private rewriteDocument(
    referenceType: CashBasisReferenceType,
    referenceId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    switch (referenceType) {
      case 'PaymentReceive':
        return this.paymentReceivedGLEntries.rewritePaymentCashGLEntries(
          referenceId,
          trx,
        );
      case 'BillPayment':
        return this.billPaymentGLEntries.rewritePaymentCashGLEntries(
          referenceId,
          trx,
        );
      case 'RefundCreditNote':
        return this.refundCreditNoteGLEntries.rewriteRefundCreditCashGLEntries(
          referenceId,
          trx,
        );
      case 'RefundVendorCredit':
        return this.refundVendorCreditGLEntries.rewriteRefundVendorCreditCashGLEntries(
          referenceId,
          trx,
        );
    }
  }

  /**
   * Rebuilds the cash basis entries of all the payments and refunds of the
   * current tenant and removes cash entries left by deleted documents.
   * @returns {Promise<ICashBasisRebuildResult>}
   */
  public async rebuild(
    organizationId: string,
  ): Promise<ICashBasisRebuildResult> {
    const knex = this.tenantKnex();
    const result: ICashBasisRebuildResult = {
      organizationId,
      rebuilt: {
        PaymentReceive: 0,
        BillPayment: 0,
        RefundCreditNote: 0,
        RefundVendorCredit: 0,
        LandedCost: 0,
      },
      orphansRemoved: 0,
      failures: [],
    };

    const isLocked = await getLockedPeriodChecker(knex);
    result.lockedSkipped = [];

    for (const { referenceType, table, dateColumn } of CASH_BASIS_DOCUMENTS) {
      // In date, then id order: each document's running-total split starts
      // from the earlier ones.
      const rows: { id: number; date: any }[] = await knex(table)
        .select('id', `${dateColumn} as date`)
        .orderBy([
          { column: dateColumn, order: 'asc' },
          { column: 'id', order: 'asc' },
        ]);

      for (const { id, date } of rows) {
        // Locked periods stay as they are.
        if (isLocked(date, referenceType)) {
          result.lockedSkipped.push({ referenceType, referenceId: id });
          continue;
        }
        try {
          await knex.transaction((trx) =>
            this.rewriteDocument(referenceType, id, trx),
          );
          result.rebuilt[referenceType] += 1;
        } catch (error) {
          result.failures.push({
            referenceType,
            referenceId: id,
            error: error?.message ?? String(error),
          });
        }
      }
      // Cash entries whose document no longer exists.
      const orphans: { referenceId: number }[] = await knex(
        'accounts_transactions',
      )
        .distinct('reference_id as referenceId')
        .where('reference_type', referenceType)
        .where('basis', AccountingBasis.Cash)
        .whereNotIn('reference_id', knex(table).select('id'));

      for (const { referenceId } of orphans) {
        await knex.transaction((trx) =>
          this.ledgerStorage.deleteByReference(
            referenceId,
            referenceType,
            trx,
            {
              basis: AccountingBasis.Cash,
            },
          ),
        );
        result.orphansRemoved += 1;
      }
    }
    await this.rebuildLandedCosts(knex, isLocked, result);

    return result;
  }

  /**
   * Rebuilds the cash basis entries of the landed costs from bills: on the
   * cash basis they follow the payments of the bill they come from, so they
   * are rewritten after the bill payments. Landed costs posted before the
   * basis tagging get their untagged entries tagged accrual on the way (see
   * `rewriteLandedCostsCashGLEntriesOfSourceBills`).
   */
  private async rebuildLandedCosts(
    knex: Knex,
    isLocked: (date: any, referenceType: string) => boolean,
    result: ICashBasisRebuildResult,
  ): Promise<void> {
    const landedCosts: { id: number; fromBillId: number }[] = await knex(
      'bill_located_costs',
    )
      .where('from_transaction_type', 'Bill')
      .select('id', 'from_transaction_id as fromBillId')
      .orderBy('id');

    const bySourceBill = new Map<number, number[]>();
    landedCosts.forEach(({ id, fromBillId }) =>
      bySourceBill.set(fromBillId, [
        ...(bySourceBill.get(fromBillId) || []),
        id,
      ]),
    );
    for (const [fromBillId, landedCostsIds] of bySourceBill) {
      // The cash set is dated at the source bill's payments: left as it is
      // when one of them is in a locked period.
      const payments: { date: any }[] = await knex(
        'bills_payments_entries as e',
      )
        .join('bills_payments as p', 'p.id', 'e.bill_payment_id')
        .where('e.bill_id', fromBillId)
        .select('p.payment_date as date');

      if (payments.some(({ date }) => isLocked(date, 'LandedCost'))) {
        landedCostsIds.forEach((referenceId) =>
          result.lockedSkipped.push({
            referenceType: 'LandedCost',
            referenceId,
          }),
        );
        continue;
      }
      try {
        await knex.transaction((trx) =>
          this.landedCostGLEntries.rewriteLandedCostsCashGLEntriesOfSourceBills(
            [fromBillId],
            trx,
          ),
        );
        result.rebuilt.LandedCost += landedCostsIds.length;
      } catch (error) {
        landedCostsIds.forEach((referenceId) =>
          result.failures.push({
            referenceType: 'LandedCost',
            referenceId,
            error: error?.message ?? String(error),
          }),
        );
      }
    }
  }

  /**
   * Checks the cash basis ledger of the current tenant.
   * @returns {Promise<ICashBasisCheckResult>}
   */
  public check(): Promise<ICashBasisCheckResult> {
    return checkCashBasis(this.tenantKnex());
  }
}
