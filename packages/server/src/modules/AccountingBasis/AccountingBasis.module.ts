import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsReceivedModule } from '../PaymentReceived/PaymentsReceived.module';
import { BillPaymentsModule } from '../BillPayments/BillPayments.module';
import { CreditNoteRefundsModule } from '../CreditNoteRefunds/CreditNoteRefunds.module';
import { VendorCreditsRefundModule } from '../VendorCreditsRefund/VendorCreditsRefund.module';
import { LedgerModule } from '../Ledger/Ledger.module';
import { BillLandedCostsModule } from '../EE/BillLandedCosts/BillLandedCosts.module';
import { CASH_BASIS_REBUILD_QUEUE } from './AccountingBasis.constants';
import { CashBasisRebuildService } from './CashBasisRebuild.service';
import { CashBasisRebuildProcessor } from './CashBasisRebuild.processor';
import { CashBasisAutoRebuildService } from './CashBasisAutoRebuild.service';
import { AccountsModule } from '../Accounts/Accounts.module';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { CreditApplicationsGLService } from './CreditApplicationsGL.service';
import { CreditApplicationsGLSubscriber } from './CreditApplicationsGL.subscriber';
import { StaleJournalsRepairService } from './StaleJournalsRepair.service';
import { StockQuantitiesRepairService } from './StockQuantitiesRepair.service';
import { RefundJournalsRepairService } from './RefundJournalsRepair.service';

/**
 * Maintenance of the cash basis ledger: rebuilds the cash basis entries of
 * the payments and refunds from their documents. Also posts the exchange
 * lines of the credits applied to invoices and bills, and repairs the
 * journals older fixes only correct on the next save (stale journals), and the
 * journals of foreign currency refunds posted unconverted.
 */
@Module({
  imports: [
    PaymentsReceivedModule,
    BillPaymentsModule,
    CreditNoteRefundsModule,
    VendorCreditsRefundModule,
    BillLandedCostsModule,
    LedgerModule,
    AccountsModule,
    TenancyModule,
    BullModule.registerQueue({ name: CASH_BASIS_REBUILD_QUEUE }),
  ],
  providers: [
    CashBasisRebuildService,
    CashBasisRebuildProcessor,
    CashBasisAutoRebuildService,
    CreditApplicationsGLService,
    CreditApplicationsGLSubscriber,
    StaleJournalsRepairService,
    StockQuantitiesRepairService,
    RefundJournalsRepairService,
  ],
  exports: [
    CashBasisRebuildService,
    CreditApplicationsGLService,
    StaleJournalsRepairService,
    StockQuantitiesRepairService,
    RefundJournalsRepairService,
  ],
})
export class AccountingBasisModule {}
