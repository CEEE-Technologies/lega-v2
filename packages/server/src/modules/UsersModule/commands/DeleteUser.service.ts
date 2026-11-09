import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject, Injectable } from '@nestjs/common';
import { AdminAccessService } from '@/modules/Roles/AdminAccess.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { ITenantUserDeletedPayload } from '../Users.types';
import { events } from '@/common/events/events';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../Users.constants';
import { TenantUserOwnerService } from './TenantUserOwner.service';

@Injectable()
export class DeleteUserService {
  constructor(
    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,
    private readonly eventEmitter: EventEmitter2,
    private readonly tenancyContext: TenancyContext,
    private readonly tenantUserOwner: TenantUserOwnerService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  /**
   * Removes the given user from the current organization. Their login and
   * their other organizations are untouched.
   * @param {number} userId - User id.
   */
  async deleteUser(userId: number): Promise<void> {
    // Retrieve user details or throw not found service error.
    const tenantUser = await this.tenantUserModel().query().findById(userId);

    if (!tenantUser) {
      throw new ServiceError(ERRORS.USER_NOT_FOUND);
    }
    const authorizedUser = await this.tenancyContext.getSystemUser();

    // Nobody can remove themselves.
    if (tenantUser.systemUserId === authorizedUser.id) {
      throw new ServiceError(ERRORS.USER_SAME_THE_AUTHORIZED_USER);
    }
    // Nobody can remove the owner.
    await this.tenantUserOwner.throwIfOwner(tenantUser);

    // Only the owner and admins can remove an admin.
    await this.adminAccess.throwUnlessAdminForAdminUser(tenantUser);

    // Validate the delete user should not be the last active user.
    if (tenantUser.isInviteAccepted) {
      await this.validateNotLastUserDelete();
    }
    // Delete user from the storage.
    await this.tenantUserModel().query().findById(userId).delete();

    // Triggers `onTenantUserDeleted` event.
    await this.eventEmitter.emitAsync(events.tenantUser.onDeleted, {
      userId,
      tenantUser,
    } as ITenantUserDeletedPayload);
  }

  /**
   * Validate the delete user should not be the last user.
   * @param {number} tenantId
   */
  private async validateNotLastUserDelete() {
    const inviteAcceptedUsers = await this.tenantUserModel()
      .query()
      .select(['id'])
      .whereNotNull('invite_accepted_at');

    if (inviteAcceptedUsers.length === 1) {
      throw new ServiceError(ERRORS.CANNOT_DELETE_LAST_USER);
    }
  }
}
