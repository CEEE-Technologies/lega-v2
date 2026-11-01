import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Scope } from '@nestjs/common';
import { ClsService, UseCls } from 'nestjs-cls';
import { SendInviteUserMailQueue } from '../Users.constants';
import { SendInviteUserMailJobPayload } from '../Users.types';
import { SendInviteUsersMailMessage } from '../commands/SendInviteUsersMailMessage.service';
import { UserInvite } from '../models/InviteUser.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';

@Processor({
  name: SendInviteUserMailQueue,
  scope: Scope.REQUEST,
})
export class SendInviteUserMailProcessor extends WorkerHost {
  constructor(
    private readonly sendInviteUsersMailService: SendInviteUsersMailMessage,
    private readonly clsService: ClsService,

    @Inject(UserInvite.name)
    private readonly inviteModel: typeof UserInvite,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,
  ) {
    super();
  }

  @UseCls()
  async process(job: Job<SendInviteUserMailJobPayload>) {
    const { fromUserId, inviteId, organizationId, userId } = job.data;

    this.clsService.set('organizationId', organizationId);
    this.clsService.set('userId', userId);

    try {
      // The invite may have been accepted, resent or removed since.
      const invite = await this.inviteModel.query().findById(inviteId);
      if (!invite) return;

      const fromUser = await this.tenantUserModel()
        .query()
        .findById(fromUserId);
      if (!fromUser) return;

      await this.sendInviteUsersMailService.sendInviteMail(fromUser, invite);
    } catch (error) {
      console.error('Failed to process invite user mail job:', error);
      throw error;
    }
  }
}
