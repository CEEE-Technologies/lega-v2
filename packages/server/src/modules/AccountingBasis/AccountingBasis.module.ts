import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsReceivedModule } from '../PaymentReceived/PaymentsReceived.module';
import { BillPaymentsModule } from '../BillPayments/BillPayments.module';
import { CreditNoteRefundsModule } from '../CreditNoteRefunds/CreditNoteRefunds.module';
import { VendorCreditsRefundModule } from '../VendorCreditsRefund/VendorCreditsRefund.module';
import { LedgerModule } from '../Ledger/Ledger.module';
import { CASH_BASIS_REBUILD_QUEUE } from './AccountingBasis.constants';
import { CashBasisRebuildService } from './CashBasisRebuild.service';
import { CashBasisRebuildProcessor } from './CashBasisRebuild.processor';

/**
 * Maintenance of the cash basis ledger: rebuilds the cash basis entries of
 * the payments and refunds from their documents.
 */
@Module({
  imports: [
    PaymentsReceivedModule,
    BillPaymentsModule,
    CreditNoteRefundsModule,
    VendorCreditsRefundModule,
    LedgerModule,
    BullModule.registerQueue({ name: CASH_BASIS_REBUILD_QUEUE }),
  ],
  providers: [CashBasisRebuildService, CashBasisRebuildProcessor],
  exports: [CashBasisRebuildService],
})
export class AccountingBasisModule {}
