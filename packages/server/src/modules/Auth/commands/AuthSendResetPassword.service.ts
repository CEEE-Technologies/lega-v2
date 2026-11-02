import * as crypto from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  IAuthSendedResetPassword,
  IAuthSendingResetPassword,
} from '../Auth.interfaces';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PasswordReset } from '../models/PasswordReset';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { events } from '@/common/events/events';
import { hashPasswordResetToken } from '../Auth.utils';

@Injectable()
export class AuthSendResetPasswordService {
  /**
   * @param {EventEmitter2} eventPublisher - Event emitter.
   * @param {typeof PasswordReset} resetPasswordModel - Password reset model.
   * @param {typeof SystemUser} systemUserModel - System user model.
   */
  constructor(
    private readonly eventPublisher: EventEmitter2,

    @Inject(PasswordReset.name)
    private readonly resetPasswordModel: typeof PasswordReset,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,
  ) {}

  /**
   * Sends the given email reset password email. The mail job creates the
   * reset token (`issueResetToken`) when it sends the mail.
   * @param {string} email - Email address.
   */
  async sendResetPassword(email: string): Promise<void> {
    const user = await this.systemUserModel.query().findOne({ email });

    if (!user) return;

    // Triggers sending reset password event.
    await this.eventPublisher.emitAsync(events.auth.sendingResetPassword, {
      user,
    } as IAuthSendingResetPassword);

    // Triggers sent reset password event (queues the mail job).
    await this.eventPublisher.emitAsync(events.auth.sendResetPassword, {
      user,
    } as IAuthSendedResetPassword);
  }

  /**
   * Creates a new reset token for the email and replaces any older one.
   * Only the token's SHA-256 hash is stored; the raw token is returned so
   * it can be put in the mail, and is not kept anywhere else.
   * @param {string} email - Email address.
   * @returns {Promise<string>} The raw token.
   */
  async issueResetToken(email: string): Promise<string> {
    const token: string = crypto.randomBytes(32).toString('hex');

    // Delete all stored tokens of reset password that associate to the give email.
    await this.deletePasswordResetToken(email);

    await this.resetPasswordModel
      .query()
      .insert({ email, tokenHash: hashPasswordResetToken(token) });

    return token;
  }

  /**
   * Deletes the password reset token by the given email.
   * @param {string} email
   * @returns {Promise}
   */
  private async deletePasswordResetToken(email: string) {
    return this.resetPasswordModel.query().where('email', email).delete();
  }
}
