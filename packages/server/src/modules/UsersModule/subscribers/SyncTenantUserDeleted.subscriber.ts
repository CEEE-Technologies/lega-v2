import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { ITenantUserDeletedPayload } from '../Users.types';
import { UserInvite } from '../models/InviteUser.model';

/**
 * Removes the deleted user's access to this organization only. Their login
 * and their other organizations are untouched.
 */
@Injectable()
export class SyncTenantUserDeleteSubscriber {
  constructor(
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(UserInvite.name)
    private readonly inviteModel: typeof UserInvite,

    private readonly tenancyContext: TenancyContext,
  ) {}

  /**
   * @param {ITenantUserDeletedPayload} payload -
   */
  @OnEvent(events.tenantUser.onDeleted)
  async syncSystemUserOnceUserDeleted({
    tenantUser,
  }: ITenantUserDeletedPayload) {
    const userId = tenantUser.systemUserId;
    if (!userId) return;

    const tenant = await this.tenancyContext.getTenant();

    // Remove the membership of this organization.
    await this.userTenantModel
      .query()
      .where({ userId, tenantId: tenant.id })
      .delete();

    // Remove any pending invite to this organization.
    await this.inviteModel
      .query()
      .where({ userId, tenantId: tenant.id })
      .delete();

    // Stop opening this organization by default at sign-in.
    await this.systemUserModel
      .query()
      .where({ id: userId, defaultTenantId: tenant.id })
      .patch({ defaultTenantId: null });
  }
}
