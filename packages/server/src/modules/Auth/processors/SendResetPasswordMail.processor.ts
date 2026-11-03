import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Scope } from '@nestjs/common';
import { Job } from 'bullmq';
import { SendResetPasswordMailQueue } from '../Auth.constants';
import { AuthenticationMailMesssages } from '../AuthMailMessages.esrvice';
import { MailTransporter } from '@/modules/Mail/MailTransporter.service';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { AuthSendResetPasswordService } from '../commands/AuthSendResetPassword.service';

@Processor({
  name: SendResetPasswordMailQueue,
  scope: Scope.REQUEST,
})
export class SendResetPasswordMailProcessor extends WorkerHost {
  constructor(
    private readonly authMailMesssages: AuthenticationMailMesssages,
    private readonly mailTransporter: MailTransporter,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    private readonly sendResetPasswordService: AuthSendResetPasswordService,
  ) {
    super();
  }

  /**
   * The job holds only the user id. The reset token is created here, when
   * the mail is sent: only its hash is stored, and the raw token goes in
   * the mail only, so it is never in the database or the queue.
   */
  async process(job: Job<SendResetPasswordMailJobPayload>) {
    try {
      const user = await this.systemUserModel.query().findById(job.data.userId);
      if (!user) return;

      const token = await this.sendResetPasswordService.issueResetToken(
        user.email,
      );
      await this.authMailMesssages.sendResetPasswordMail(user, token);
    } catch (error) {
      console.log('Error occured during send reset password mail', error);
    }
  }
}

export interface SendResetPasswordMailJobPayload {
  userId: number;
}
