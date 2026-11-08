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
export const PERMISSIONS_NOT_HELD_MESSAGE =
  'You can only give permissions you have yourself.';

export interface IPermissionRef {
  subject: string;
  ability: string;
  value?: boolean | number | null;
}

const permissionKey = (permission: IPermissionRef) =>
  `${permission.subject}:${permission.ability}`;

/** Whether the permission is granted (value true, or not given). */
const isGranted = (permission: IPermissionRef) =>
  permission.value === undefined ||
  permission.value === true ||
  Number(permission.value) === 1;

/**
 * Decides who may give or change the Admin role. Only the owner and users
 * with the Admin role may, so a user who can only manage users or edit roles
 * can't make anyone (themselves included) an admin in effect.
 *
 * Anyone else may only give the permissions they hold themselves, through
 * a role they create or edit, or a role they give someone.
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

  /**
   * Throws unless the signed-in user is the owner or an admin, when the
   * target user has the Admin role: only they may deactivate, reactivate or
   * remove an admin (the same rule as giving the role).
   * @param {{ roleId?: number | null }} targetUser
   * @throws {ServiceError}
   */
  async throwUnlessAdminForAdminUser(targetUser: {
    roleId?: number | null;
  }): Promise<void> {
    if (await this.isAdminRole(targetUser.roleId)) {
      await this.throwUnlessAdmin();
    }
  }

  /**
   * The permissions the signed-in user's role grants, as `subject:ability`.
   * @returns {Promise<Set<string>>}
   */
  async getCurrentUserPermissions(): Promise<Set<string>> {
    const roleId = await this.getCurrentUserRoleId();
    return new Set((await this.getRolePermissions(roleId)).map(permissionKey));
  }

  /**
   * The permissions the role grants.
   * @param {number} roleId
   */
  async getRolePermissions(
    roleId: number | null | undefined,
  ): Promise<IPermissionRef[]> {
    if (!roleId) return [];
    const role = await this.roleModel()
      .query()
      .findById(roleId)
      .withGraphFetched('permissions');
    return ((role as any)?.permissions ?? []).filter(isGranted);
  }

  /**
   * Throws unless the signed-in user is the owner or an admin, or holds
   * every granted permission in the list.
   * @param {IPermissionRef[]} permissions
   * @throws {ServiceError}
   */
  async throwUnlessHoldsPermissions(
    permissions: IPermissionRef[],
  ): Promise<void> {
    const granted = permissions.filter(isGranted);
    if (granted.length === 0) return;
    if (await this.isCurrentUserAdmin()) return;

    const held = await this.getCurrentUserPermissions();
    const missing = granted.filter((p) => !held.has(permissionKey(p)));
    if (missing.length > 0) {
      throw new ServiceError(
        ERRORS.PERMISSIONS_NOT_HELD,
        PERMISSIONS_NOT_HELD_MESSAGE,
        {
          missing: missing.map((p) => ({
            subject: p.subject,
            ability: p.ability,
          })),
        },
      );
    }
  }

  /**
   * Throws unless the signed-in user may give the role to someone: the Admin
   * role needs the owner or an admin; any other role needs its permissions.
   * @param {number} roleId
   * @throws {ServiceError}
   */
  async throwUnlessMayGiveRole(roleId: number): Promise<void> {
    if (await this.isAdminRole(roleId)) {
      await this.throwUnlessAdmin();
      return;
    }
    await this.throwUnlessHoldsPermissions(
      await this.getRolePermissions(roleId),
    );
  }
}
