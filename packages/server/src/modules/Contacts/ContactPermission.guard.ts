import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { Contact } from './models/Contact';

export const CONTACT_PERMISSION_KEY = 'contactPermission';

/**
 * Checks a Customer or a Vendor permission, whichever the contact in the
 * `:id` route param is. Runs after `AuthorizationGuard`, which attaches the
 * ability to the request.
 */
@Injectable()
export class ContactPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,

    @Inject(Contact.name)
    private readonly contactModel: TenantModelProxy<typeof Contact>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<string>(
      CONTACT_PERMISSION_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest();
    const ability = request.ability;

    if (!action || !ability) {
      throw new ForbiddenException('You do not have permission.');
    }
    const contact = await this.contactModel()
      .query()
      .findById(Number(request.params.id));

    // Unknown contact: the service answers "not found".
    if (!contact) return true;

    const subject =
      contact.contactService === 'vendor'
        ? AbilitySubject.Vendor
        : AbilitySubject.Customer;

    if (!ability.can(action, subject)) {
      throw new ForbiddenException(
        `You do not have permission to ${action} ${subject}`,
      );
    }
    return true;
  }
}

/**
 * The route needs the given Customer or Vendor permission, depending on the
 * contact. `AllowAnyMember` only lets it past the generic `PermissionGuard`;
 * `ContactPermissionGuard` does the check.
 */
export const RequireContactPermission = (action: string) =>
  applyDecorators(
    SetMetadata(CONTACT_PERMISSION_KEY, action),
    AllowAnyMember(),
    UseGuards(ContactPermissionGuard),
  );
