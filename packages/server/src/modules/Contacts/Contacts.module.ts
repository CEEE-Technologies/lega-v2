import { Module } from '@nestjs/common';
import { GetAutoCompleteContactsService } from './queries/GetAutoCompleteContacts.service';
import { GetContactService } from './queries/GetContact.service';
import { ContactsController } from './Contacts.controller';
import { ActivateContactService } from './commands/ActivateContact.service';
import { InactivateContactService } from './commands/InactivateContact.service';
import { ContactOpeningBalanceAccount } from './ContactOpeningBalanceAccount.service';
import { ContactOpeningBalancePayment } from './ContactOpeningBalancePayment.service';

@Module({
  providers: [
    GetAutoCompleteContactsService,
    GetContactService,
    ActivateContactService,
    InactivateContactService,
    ContactOpeningBalanceAccount,
    ContactOpeningBalancePayment,
  ],
  exports: [ContactOpeningBalanceAccount, ContactOpeningBalancePayment],
  controllers: [ContactsController],
})
export class ContactsModule {}
