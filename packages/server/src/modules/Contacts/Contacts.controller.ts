import {
  Controller,
  Get,
  Query,
  Param,
  Patch,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { GetContactsAutoCompleteQuery } from './dtos/GetContactsAutoCompleteQuery.dto';
import { ContactAutoCompleteItemDto } from './dtos/ContactAutoCompleteItem.dto';
import { ContactResponseDto } from './dtos/ContactResponse.dto';
import { GetAutoCompleteContactsService } from './queries/GetAutoCompleteContacts.service';
import { GetContactService } from './queries/GetContact.service';
import { ActivateContactService } from './commands/ActivateContact.service';
import { InactivateContactService } from './commands/InactivateContact.service';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { CustomerAction } from '@/modules/Customers/types/Customers.types';
import { RequireContactPermission } from './ContactPermission.guard';

@Controller('contacts')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Contacts')
@ApiExtraModels(ContactAutoCompleteItemDto, ContactResponseDto)
@ApiCommonHeaders()
export class ContactsController {
  constructor(
    private readonly getAutoCompleteService: GetAutoCompleteContactsService,
    private readonly getContactService: GetContactService,
    private readonly activateContactService: ActivateContactService,
    private readonly inactivateContactService: InactivateContactService,
  ) {}

  @Get('auto-complete')
  @AllowAnyMember()
  @ApiOperation({ summary: 'Get the auto-complete contacts' })
  @ApiResponse({
    status: 200,
    description: 'Contacts auto-complete list.',
    schema: {
      type: 'array',
      items: { $ref: getSchemaPath(ContactAutoCompleteItemDto) },
    },
  })
  getAutoComplete(@Query() query: GetContactsAutoCompleteQuery) {
    return this.getAutoCompleteService.autocompleteContacts(query);
  }

  @Get(':id')
  @RequireContactPermission(CustomerAction.View)
  @ApiOperation({ summary: 'Get contact by ID (customer or vendor)' })
  @ApiParam({ name: 'id', type: Number, description: 'Contact ID' })
  @ApiResponse({
    status: 200,
    description:
      'Contact details (under "customer" key for form/duplicate use)',
    schema: {
      $ref: getSchemaPath(ContactResponseDto),
    },
  })
  getContact(@Param('id', ParseIntPipe) contactId: number) {
    return this.getContactService.getContact(contactId);
  }

  @Patch(':id/activate')
  @RequireContactPermission(CustomerAction.Edit)
  @ApiOperation({ summary: 'Activate a contact' })
  @ApiParam({ name: 'id', type: 'number', description: 'Contact ID' })
  async activateContact(@Param('id', ParseIntPipe) contactId: number) {
    await this.activateContactService.activateContact(contactId);
    return { id: contactId, activated: true };
  }

  @Patch(':id/inactivate')
  @RequireContactPermission(CustomerAction.Edit)
  @ApiOperation({ summary: 'Inactivate a contact' })
  @ApiParam({ name: 'id', type: 'number', description: 'Contact ID' })
  async inactivateContact(@Param('id', ParseIntPipe) contactId: number) {
    await this.inactivateContactService.inactivateContact(contactId);
    return { id: contactId, inactivated: true };
  }
}
