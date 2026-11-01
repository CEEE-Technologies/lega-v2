import { SetMetadata } from '@nestjs/common';
import { AbilitySubject } from './Roles.types';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';
export const ALLOW_ANY_MEMBER_KEY = 'allowAnyMember';

export interface RequiredPermission {
  ability: string;
  subject: AbilitySubject | string;
}

/**
 * Decorator to specify required ability and subject for a route handler or controller.
 * @param ability - The ability/action required (e.g., 'Create', 'View', 'Edit', 'Delete')
 * @param subject - The subject/entity the ability applies to (e.g., AbilitySubject.Item, AbilitySubject.SaleInvoice)
 * @example
 * ```typescript
 * @RequirePermission('Create', AbilitySubject.Item)
 * @Post()
 * async createItem(@Body() dto: CreateItemDto) { ... }
 *
 * @RequirePermission('View', AbilitySubject.SaleInvoice)
 * @Get(':id')
 * async getInvoice(@Param('id') id: number) { ... }
 * ```
 */
export const RequirePermission = (
  ability: string,
  subject: AbilitySubject | string,
) => SetMetadata(REQUIRED_PERMISSION_KEY, { ability, subject });

/**
 * Only the Admin role may use the route. For routes that have no matching
 * permission in the roles schema (organization build, import, export, API
 * keys, subscription, branches). Admin is the only role granted `manage all`.
 */
export const RequireAdmin = () => RequirePermission('manage', 'all');

/**
 * Any member of the organization may use the route, whatever their role.
 * Only for reads every screen needs to load (settings, currencies, views,
 * resource meta, ...). The `PermissionGuard` refuses routes that carry
 * neither this nor a `RequirePermission` rule to anyone but Admin.
 */
export const AllowAnyMember = () => SetMetadata(ALLOW_ANY_MEMBER_KEY, true);
