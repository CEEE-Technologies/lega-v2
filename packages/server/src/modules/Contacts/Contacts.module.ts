import { Module } from '@nestjs/common';
import { GetAutoCompleteContactsService } from './queries/GetAutoCompleteContacts.service';
import { GetContactService } from './queries/GetContact.service';
import { ContactsController } from './Contacts.controller';
import { ActivateContactService } from './commands/ActivateContact.service';
import { InactivateContactService } from './commands/InactivateContact.service';
import { ContactOpeningBalanceAccount } from './ContactOpeningBalanceAccount.service';
import { ContactOpeningBalancePayment } from './ContactOpeningBalancePayment.service';
import { ContactPermissionGuard } from './ContactPermission.guard';

@Module({
  providers: [
    GetAutoCompleteContactsService,
    GetContactService,
    ActivateContactService,
    InactivateContactService,
    ContactOpeningBalanceAccount,
    ContactOpeningBalancePayment,
    ContactPermissionGuard,
  ],
  exports: [ContactOpeningBalanceAccount, ContactOpeningBalancePayment],
  controllers: [ContactsController],
})
export class ContactsModule {}
