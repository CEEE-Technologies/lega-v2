import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Scope } from '@nestjs/common';
import { Job } from 'bullmq';
import { SendResetPasswordMailQueue } from '../Auth.constants';
import { AuthenticationMailMesssages } from '../AuthMailMessages.esrvice';
import { MailTransporter } from '@/modules/Mail/MailTransporter.service';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { PasswordReset } from '../models/PasswordReset';

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

    @Inject(PasswordReset.name)
    private readonly passwordResetModel: typeof PasswordReset,
  ) {
    super();
  }

  /**
   * The job holds only the user id. The reset code is read when the mail is
   * sent, so it is never stored in the queue.
   */
  async process(job: Job<SendResetPasswordMailJobPayload>) {
    try {
      const user = await this.systemUserModel.query().findById(job.data.userId);
      if (!user) return;

      const passwordReset = await this.passwordResetModel
        .query()
        .where('email', user.email)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .first();
      if (!passwordReset) return;

      await this.authMailMesssages.sendResetPasswordMail(
        user,
        passwordReset.token,
      );
    } catch (error) {
      console.log('Error occured during send reset password mail', error);
    }
  }
}

export interface SendResetPasswordMailJobPayload {
  userId: number;
}
