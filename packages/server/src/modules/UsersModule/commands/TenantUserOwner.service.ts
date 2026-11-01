import { Inject, Injectable } from '@nestjs/common';
import { ModelObject } from 'objection';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { ERRORS } from '../Users.constants';

/**
 * Protects the organization owner: only the owner may edit their own user,
 * and nobody may deactivate or remove them.
 */
@Injectable()
export class TenantUserOwnerService {
  constructor(
    private readonly tenancyContext: TenancyContext,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,
  ) {}

  /**
   * Whether the given login owns the current organization.
   * @param {number} systemUserId
   * @returns {Promise<boolean>}
   */
  async isOwner(systemUserId: number | null | undefined): Promise<boolean> {
    if (!systemUserId) return false;
    const tenant = await this.tenancyContext.getTenant();
    const membership = await this.userTenantModel
      .query()
      .findOne({ userId: systemUserId, tenantId: tenant.id });

    return membership?.role === 'owner';
  }

  /**
   * Throws when the given user owns the organization and the signed-in user
   * is someone else.
   * @param {ModelObject<TenantUser>} tenantUser - The user being changed.
   * @param {number} authorizedSystemUserId - The signed-in login.
   */
  async throwIfOwnerOfSomeoneElse(
    tenantUser: ModelObject<TenantUser>,
    authorizedSystemUserId: number,
  ): Promise<void> {
    if (tenantUser.systemUserId === authorizedSystemUserId) return;

    if (await this.isOwner(tenantUser.systemUserId)) {
      throw new ServiceError(
        ERRORS.CANNOT_MUTATE_OWNER,
        'Only the owner can change or remove the owner of the organization.',
      );
    }
  }

  /**
   * Throws when the given user owns the organization, whoever asks.
   * @param {ModelObject<TenantUser>} tenantUser - The user being changed.
   */
  async throwIfOwner(tenantUser: ModelObject<TenantUser>): Promise<void> {
    if (await this.isOwner(tenantUser.systemUserId)) {
      throw new ServiceError(
        ERRORS.CANNOT_MUTATE_OWNER,
        'The owner of the organization cannot be deactivated or removed.',
      );
    }
  }
}
