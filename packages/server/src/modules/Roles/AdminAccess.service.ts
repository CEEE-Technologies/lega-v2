import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { Role } from './models/Role.model';
import { ERRORS } from './constants';

export const ADMIN_ROLE_SLUG = 'admin';
export const ADMIN_ONLY_MESSAGE = 'Only an admin can do this.';

/**
 * Decides who may give or change the Admin role. Only the owner and users
 * with the Admin role may, so a user who can only manage users or edit roles
 * can't make anyone (themselves included) an admin in effect.
 */
@Injectable()
export class AdminAccessService {
  constructor(
    private readonly cls: ClsService,
    private readonly tenancyContext: TenancyContext,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    @Inject(Role.name)
    private readonly roleModel: TenantModelProxy<typeof Role>,
  ) {}

  /**
   * Whether the signed-in user owns the current organization or has the
   * Admin role in it.
   * @returns {Promise<boolean>}
   */
  async isCurrentUserAdmin(): Promise<boolean> {
    const systemUserId = this.cls.get<number>('userId');
    if (!systemUserId) return false;

    const tenant = await this.tenancyContext.getTenant();
    const membership = await this.userTenantModel
      .query()
      .findOne({ userId: systemUserId, tenantId: tenant.id });

    if (membership?.role === 'owner') return true;

    const tenantUser = await this.tenantUserModel()
      .query()
      .findOne({ systemUserId })
      .withGraphFetched('role');

    return tenantUser?.role?.slug === ADMIN_ROLE_SLUG;
  }

  /**
   * The role id of the signed-in user in the current organization.
   * @returns {Promise<number | undefined>}
   */
  async getCurrentUserRoleId(): Promise<number | undefined> {
    const systemUserId = this.cls.get<number>('userId');
    if (!systemUserId) return undefined;

    const tenantUser = await this.tenantUserModel()
      .query()
      .findOne({ systemUserId });
    return tenantUser?.roleId;
  }

  /**
   * Whether the given role is the Admin role.
   * @param {number} roleId
   * @returns {Promise<boolean>}
   */
  async isAdminRole(roleId: number | null | undefined): Promise<boolean> {
    if (!roleId) return false;
    const role = await this.roleModel().query().findById(roleId);
    return role?.slug === ADMIN_ROLE_SLUG;
  }

  /**
   * Throws unless the signed-in user is the owner or an admin.
   * @throws {ServiceError}
   */
  async throwUnlessAdmin(): Promise<void> {
    if (!(await this.isCurrentUserAdmin())) {
      throw new ServiceError(ERRORS.ADMIN_ONLY, ADMIN_ONLY_MESSAGE);
    }
  }
}
