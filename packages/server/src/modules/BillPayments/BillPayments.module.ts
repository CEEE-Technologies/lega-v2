import { Module } from '@nestjs/common';
import { BillPaymentsApplication } from './BillPaymentsApplication.service';
import { CreateBillPaymentService } from './commands/CreateBillPayment.service';
import { EditBillPayment } from './commands/EditBillPayment.service';
import { GetBillPayment } from './queries/GetBillPayment.service';
import { DeleteBillPayment } from './commands/DeleteBillPayment.service';
import { BillPaymentBillSync } from './commands/BillPaymentBillSync.service';
import { GetPaymentBills } from './queries/GetPaymentBills.service';
import { BillPaymentValidators } from './commands/BillPaymentValidators.service';
import { CommandBillPaymentDTOTransformer } from './commands/CommandBillPaymentDTOTransformer.service';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { BranchTransactionDTOTransformer } from '../Branches/integrations/BranchTransactionDTOTransform';
import { BranchesSettingsService } from '../Branches/BranchesSettings';
import { BillPaymentsController } from './BillPayments.controller';
import { BillPaymentGLEntries } from './commands/BillPaymentGLEntries';
import { BillPaymentGLEntriesSubscriber } from './subscribers/BillPaymentGLEntriesSubscriber';
import { BillPaymentBillSyncSubscriber } from './subscribers/BillPaymentBillSyncSubscriber';
import { LedgerModule } from '../Ledger/Ledger.module';
import { AccountsModule } from '../Accounts/Accounts.module';
import { ContactsModule } from '../Contacts/Contacts.module';
import { BillPaymentsGLEntriesRewrite } from './commands/BillPaymentsGLRewrite';
import { BillPaymentGLRewriteSubscriber } from './subscribers/BillPaymentGLRewriteSubscriber';
import { BillPaymentOpeningBalanceSubscriber } from './subscribers/BillPaymentOpeningBalanceSubscriber';
import { BillPaymentsExportable } from './queries/BillPaymentsExportable';
import { BillPaymentsImportable } from './commands/BillPaymentsImportable';
import { GetBillPaymentsService } from './queries/GetBillPayments.service';
import { DynamicListModule } from '../DynamicListing/DynamicList.module';
import { BillPaymentsPages } from './commands/BillPaymentsPages.service';
import { BulkDeleteBillPaymentsService } from './BulkDeleteBillPayments.service';
import { ValidateBulkDeleteBillPaymentsService } from './ValidateBulkDeleteBillPayments.service';
import { TransactionsLockingModule } from '../TransactionsLocking/TransactionsLocking.module';

@Module({
  imports: [
    TenancyModule,
    LedgerModule,
    AccountsModule,
    ContactsModule,
    TransactionsLockingModule,
    DynamicListModule,
  ],
  providers: [
    BillPaymentsApplication,
    CreateBillPaymentService,
    EditBillPayment,
    GetBillPayment,
    DeleteBillPayment,
    BulkDeleteBillPaymentsService,
    ValidateBulkDeleteBillPaymentsService,
    BillPaymentBillSync,
    GetPaymentBills,
    BillPaymentValidators,
    CommandBillPaymentDTOTransformer,
    BranchTransactionDTOTransformer,
    BranchesSettingsService,
    BillPaymentGLEntries,
    BillPaymentGLEntriesSubscriber,
    BillPaymentBillSyncSubscriber,
    BillPaymentsExportable,
    BillPaymentsImportable,
    GetBillPaymentsService,
    BillPaymentsPages,
    BillPaymentsGLEntriesRewrite,
    BillPaymentGLRewriteSubscriber,
    BillPaymentOpeningBalanceSubscriber,
  ],
  exports: [
    BillPaymentValidators,
    BillPaymentGLEntries,
    CreateBillPaymentService,
    BillPaymentsExportable,
    BillPaymentsImportable,
  ],
  controllers: [BillPaymentsController],
})
export class BillPaymentsModule {}
