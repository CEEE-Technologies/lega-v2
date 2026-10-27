import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { PaymentReceivedGLEntries } from '@/modules/PaymentReceived/commands/PaymentReceivedGLEntries';
import { BillPaymentGLEntries } from '@/modules/BillPayments/commands/BillPaymentGLEntries';
import { RefundCreditNoteGLEntries } from '@/modules/CreditNoteRefunds/commands/RefundCreditNoteGLEntries';
import { RefundVendorCreditGLEntries } from '@/modules/VendorCreditsRefund/commands/RefundVendorCreditGLEntries';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import {
  CASH_BASIS_DOCUMENTS,
  CashBasisReferenceType,
  ICashBasisRebuildResult,
} from './AccountingBasis.constants';
import { checkCashBasis, ICashBasisCheckResult } from './CashBasisCheck';

/**
 * Rebuilds the cash basis entries of the current tenant from the documents.
 *
 * Each payment and refund gets its cash set deleted and written again from
 * the current document state, one document per transaction, so a failure
 * leaves the other documents done and a re-run picks up where it failed.
 * Only cash-tagged entries are touched (they never change the stored
 * balances), so running it again gives the same result.
 */
@Injectable()
export class CashBasisRebuildService {
  constructor(
    private readonly paymentReceivedGLEntries: PaymentReceivedGLEntries,
    private readonly billPaymentGLEntries: BillPaymentGLEntries,
    private readonly refundCreditNoteGLEntries: RefundCreditNoteGLEntries,
    private readonly refundVendorCreditGLEntries: RefundVendorCreditGLEntries,
    private readonly ledgerStorage: LedgerStorageService,

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
      },
      orphansRemoved: 0,
      failures: [],
    };

    for (const { referenceType, table } of CASH_BASIS_DOCUMENTS) {
      const rows: { id: number }[] = await knex(table)
        .select('id')
        .orderBy('id');

      for (const { id } of rows) {
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
    return result;
  }

  /**
   * Checks the cash basis ledger of the current tenant.
   * @returns {Promise<ICashBasisCheckResult>}
   */
  public check(): Promise<ICashBasisCheckResult> {
    return checkCashBasis(this.tenantKnex());
  }
}
