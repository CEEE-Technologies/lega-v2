import {
  ITenantUserInactivatedPayload,
  ITenantUserActivatedPayload,
  ITenantUserDeletedPayload,
  ITenantUserEditedPayload,
} from '../Users.types';
import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { events } from '@/common/events/events';
import { purgeUserAbility } from '@/modules/Roles/TenantAbilities';

@Injectable()
export class PurgeUserAbilityCacheSubscriber {
  constructor(private readonly clsService: ClsService) {}

  /**
   * Purges authorized user ability once the user mutate.
   */
  // Side effect (cache purge, after the user change is saved): an error is logged and does not stop the save.
  @OnEvent(events.tenantUser.onEdited, { suppressErrors: true })
  @OnEvent(events.tenantUser.onActivated, { suppressErrors: true })
  @OnEvent(events.tenantUser.onInactivated, { suppressErrors: true })
  @OnEvent(events.tenantUser.onDeleted, { suppressErrors: true })
  purgeAuthorizedUserAbility({
    tenantUser,
  }:
    | ITenantUserInactivatedPayload
    | ITenantUserActivatedPayload
    | ITenantUserDeletedPayload
    | ITenantUserEditedPayload) {
    const organizationId = this.clsService.get<string>('organizationId');

    if (organizationId == null || tenantUser.systemUserId == null) {
      return;
    }
    purgeUserAbility(organizationId, tenantUser.systemUserId);
  }
}
