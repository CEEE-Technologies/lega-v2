import { Inject, Scope } from '@nestjs/common';
import { Job } from 'bullmq';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { SendSignupVerificationMailQueue } from '../Auth.constants';
import { MailTransporter } from '@/modules/Mail/MailTransporter.service';
import { AuthenticationMailMesssages } from '../AuthMailMessages.esrvice';
import { SystemUser } from '@/modules/System/models/SystemUser';

@Processor({
  name: SendSignupVerificationMailQueue,
  scope: Scope.REQUEST,
})
export class SendSignupVerificationMailProcessor extends WorkerHost {
  constructor(
    private readonly authMailMesssages: AuthenticationMailMesssages,
    private readonly mailTransporter: MailTransporter,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
  ) {
    super();
  }

  /**
   * The job holds only the user id. The verification code is read when the
   * mail is sent, so it is never stored in the queue.
   */
  async process(job: Job<SendSignupVerificationMailJobPayload>) {
    try {
      const user = await this.systemUserModel.query().findById(job.data.userId);
      if (!user || !user.verifyToken) return;

      await this.authMailMesssages.sendSignupVerificationMail(
        user.email,
        user.firstName,
        user.verifyToken,
      );
    } catch (error) {
      console.log('Error occured during send signup verification mail', error);
    }
  }
}

export interface SendSignupVerificationMailJobPayload {
  userId: number;
}
