import { Injectable } from '@nestjs/common';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IAuthSendedResetPassword,
  IAuthSignedUpEventPayload,
  ISignUpConfigmResendedEventPayload,
} from '../Auth.interfaces';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { SendResetPasswordMailJobPayload } from '../processors/SendResetPasswordMail.processor';
import {
  SendResetPasswordMailJob,
  SendResetPasswordMailQueue,
  SendSignupVerificationMailJob,
  SendSignupVerificationMailQueue,
} from '../Auth.constants';
import { SendSignupVerificationMailJobPayload } from '../processors/SendSignupVerificationMail.processor';

/**
 * Mail jobs are removed once sent, and failed ones after a day.
 */
export const MAIL_JOB_OPTIONS = {
  delay: 0,
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

@Injectable()
export class AuthMailSubscriber {
  constructor(
    @InjectQueue(SendResetPasswordMailQueue)
    private readonly sendResetPasswordMailQueue: Queue,

    @InjectQueue(SendSignupVerificationMailQueue)
    private readonly sendSignupVerificationMailQueue: Queue,
  ) {}

  /**
   * @param {IAuthSignedUpEventPayload | ISignUpConfigmResendedEventPayload} payload
   */
  @OnEvent(events.auth.signUp)
  @OnEvent(events.auth.signUpConfirmResended)
  async handleSignupSendVerificationMail(
    payload: IAuthSignedUpEventPayload | ISignUpConfigmResendedEventPayload,
  ) {
    try {
      // No verification code in the job; the processor reads it.
      await this.sendSignupVerificationMailQueue.add(
        SendSignupVerificationMailJob,
        {
          userId: payload.user.id,
        } as SendSignupVerificationMailJobPayload,
        MAIL_JOB_OPTIONS,
      );
    } catch (error) {
      console.log(error);
    }
  }

  /**
   * @param {IAuthSendedResetPassword} payload
   */
  @OnEvent(events.auth.sendResetPassword)
  async handleSendResetPasswordMail(payload: IAuthSendedResetPassword) {
    // No reset code or user record (password hash) in the job; the
    // processor reads what it needs.
    await this.sendResetPasswordMailQueue.add(
      SendResetPasswordMailJob,
      {
        userId: payload.user.id,
      } as SendResetPasswordMailJobPayload,
      MAIL_JOB_OPTIONS,
    );
  }
}
