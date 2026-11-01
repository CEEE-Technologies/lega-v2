import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { IS_PUBLIC_ROUTE } from '../Auth/Auth.constants';
import { getAuthApiKey } from '../Auth/Auth.utils';
import { UserTenant } from '../System/models/UserTenant.model';
import { TenantModel } from '../System/models/TenantModel';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { TenantUser } from './TenancyModels/models/TenantUser.model';

export const IS_TENANT_AGNOSTIC = 'IS_TENANT_AGNOSTIC';

export const TenantAgnosticRoute = () => SetMetadata(IS_TENANT_AGNOSTIC, true);

@Injectable()
export class TenancyGlobalGuard implements CanActivate {
  constructor(
    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    private readonly reflector: Reflector,
    private readonly clsService: ClsService,
  ) {}

  /**
   * Validates the organization ID in the request headers and enforces
   * that the authenticated user is an active member of the requested
   * organization. API-key requests are checked the same way, against the
   * organization of the key.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers['authorization']?.trim();
    const isAuthApiKey = !!getAuthApiKey(authorization || '');

    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    const isTenantAgnostic = this.reflector.getAllAndOverride<boolean>(
      IS_TENANT_AGNOSTIC,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic || isTenantAgnostic) {
      return true;
    }
    // An API key carries its own organization, set while authorizing it.
    const organizationId = isAuthApiKey
      ? this.clsService.get<string>('organizationId')
      : request.headers['organization-id'];

    if (!organizationId) {
      throw new UnauthorizedException('Organization ID is required.');
    }
    // Validate that the authenticated user is a member of the requested organization.
    const userId = this.clsService.get<number>('userId');

    const tenant = await this.tenantModel.query().findOne({ organizationId });
    if (!tenant) {
      throw new UnauthorizedException('Organization not found.');
    }

    const membership = await this.userTenantModel
      .query()
      .findOne({ userId, tenantId: tenant.id });

    if (!membership) {
      throw new UnauthorizedException(
        'You do not have access to this organization.',
      );
    }
    // A user deactivated in this organization can't use it. Their other
    // organizations aren't affected.
    if (tenant.initializedAt && (await this.isUserInactive(userId))) {
      throw new UnauthorizedException({
        message: 'Your access to this organization has been deactivated.',
        errors: [{ type: 'USER.INACTIVE' }],
      });
    }
    return true;
  }

  /**
   * Whether the user is deactivated in the current organization.
   * @param {number} systemUserId
   * @returns {Promise<boolean>}
   */
  private async isUserInactive(systemUserId: number): Promise<boolean> {
    const tenantUser = await this.tenantUserModel()
      .query()
      .findOne({ systemUserId });

    return !!tenantUser && tenantUser.active != null && !tenantUser.active;
  }
}
