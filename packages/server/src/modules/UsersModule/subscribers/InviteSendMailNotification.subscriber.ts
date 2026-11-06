import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IUserInviteTenantSyncedEventPayload,
  SendInviteUserMailJobPayload,
} from '../Users.types';
import {
  SendInviteUserMailJob,
  SendInviteUserMailQueue,
} from '../Users.constants';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';

@Injectable()
export default class InviteSendMainNotificationSubscribe {
  constructor(
    @InjectQueue(SendInviteUserMailQueue)
    private readonly sendInviteMailQueue: Queue,
    private readonly tenancyContext: TenancyContext,
  ) {}

  /**
   * Sends mail notification.
   * @param {IUserInvitedEventPayload} payload
   */
  // Side effect (invite email): an error is logged and does not stop the save.
  @OnEvent(events.inviteUser.sendInviteTenantSynced, { suppressErrors: true })
  async sendMailNotification({
    invite,
    user: _user,
    invitingUser,
  }: IUserInviteTenantSyncedEventPayload) {
    const tenant = await this.tenancyContext.getTenant();
    const authedUser = await this.tenancyContext.getSystemUser();

    const organizationId = tenant.organizationId;
    const userId = authedUser.id;

    await this.sendInviteMailQueue.add(
      SendInviteUserMailJob,
      {
        fromUserId: invitingUser?.id,
        inviteId: invite.id,
        userId,
        organizationId,
      } as SendInviteUserMailJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      },
    );
  }
}
