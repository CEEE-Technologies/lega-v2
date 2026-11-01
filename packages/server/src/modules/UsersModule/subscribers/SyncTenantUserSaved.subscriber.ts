import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ITenantUserEditedPayload } from '../Users.types';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { events } from '@/common/events/events';

/**
 * Keeps the shared login in step with the user's own edits.
 *
 * The login (and its email) is shared by every organization the person
 * belongs to, so only their own edits reach it. Edits by others, and
 * activating or deactivating, stay in this organization.
 */
@Injectable()
export class SyncTenantUserMutateSubscriber {
  constructor(
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
    private readonly clsService: ClsService,
  ) {}

  /**
   * @param {ITenantUserEditedPayload} payload
   */
  @OnEvent(events.tenantUser.onEdited)
  async syncSystemUserOnceEdited({ tenantUser }: ITenantUserEditedPayload) {
    const authorizedUserId = this.clsService.get<number>('userId');

    if (
      !tenantUser.systemUserId ||
      tenantUser.systemUserId !== authorizedUserId
    ) {
      return;
    }
    await this.systemUserModel
      .query()
      .where('id', tenantUser.systemUserId)
      .patch({
        firstName: tenantUser.firstName,
        lastName: tenantUser.lastName,
        email: tenantUser.email,
      });
  }
}
