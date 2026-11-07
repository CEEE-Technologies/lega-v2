import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';

/**
 * Tells in which of the user's organizations they are deactivated.
 *
 * Opening such an organization is refused with a 401 (TenancyGlobalGuard),
 * and the webapp signs out on a 401. The workspace list marks these
 * organizations so the switcher can show them greyed out instead.
 */
@Injectable()
export class WorkspaceUserStatusService {
  constructor(
    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    private readonly cls: ClsService,
  ) {}

  /**
   * Retrieves the organizations (of the given memberships) where the user
   * is deactivated. Organizations not built yet are skipped: they have no
   * users to look at.
   * @param {number} userId - System user id.
   * @param {UserTenant[]} memberships - With `tenant` fetched.
   * @returns {Promise<Set<string>>} Their organization ids.
   */
  public async getInactiveOrganizationIds(
    userId: number,
    memberships: UserTenant[],
  ): Promise<Set<string>> {
    const inactive = new Set<string>();

    for (const membership of memberships) {
      const tenant = membership.tenant;
      if (!tenant?.organizationId || !tenant.initializedAt) continue;

      if (await this.isUserInactive(userId, tenant.organizationId)) {
        inactive.add(tenant.organizationId);
      }
    }
    return inactive;
  }

  /**
   * Whether the user is deactivated in the organization (the same check as
   * TenancyGlobalGuard).
   * @param {number} userId - System user id.
   * @param {string} organizationId
   * @returns {Promise<boolean>}
   */
  private async isUserInactive(
    userId: number,
    organizationId: string,
  ): Promise<boolean> {
    // The tenant models read the organization from the request context.
    const previousOrganizationId = this.cls.get('organizationId');
    this.cls.set('organizationId', organizationId);
    try {
      const tenantUser = await this.tenantUserModel()
        .query()
        .findOne({ systemUserId: userId });

      return !!tenantUser && tenantUser.active != null && !tenantUser.active;
    } catch {
      // An organization whose database can't be read is left unmarked.
      return false;
    } finally {
      this.cls.set('organizationId', previousOrganizationId);
    }
  }
}
