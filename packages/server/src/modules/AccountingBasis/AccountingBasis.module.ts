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
import { AccountsModule } from '../Accounts/Accounts.module';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { CreditApplicationsGLService } from './CreditApplicationsGL.service';
import { CreditApplicationsGLSubscriber } from './CreditApplicationsGL.subscriber';

/**
 * Maintenance of the cash basis ledger: rebuilds the cash basis entries of
 * the payments and refunds from their documents. Also posts the exchange
 * lines of the credits applied to invoices and bills.
 */
@Module({
  imports: [
    PaymentsReceivedModule,
    BillPaymentsModule,
    CreditNoteRefundsModule,
    VendorCreditsRefundModule,
    LedgerModule,
    AccountsModule,
    TenancyModule,
    BullModule.registerQueue({ name: CASH_BASIS_REBUILD_QUEUE }),
  ],
  providers: [
    CashBasisRebuildService,
    CashBasisRebuildProcessor,
    CreditApplicationsGLService,
    CreditApplicationsGLSubscriber,
  ],
  exports: [CashBasisRebuildService, CreditApplicationsGLService],
})
export class AccountingBasisModule {}
