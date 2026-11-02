import { SystemModel } from '@/modules/System/models/SystemModel';

export class PasswordReset extends SystemModel {
  readonly email: string;
  /** SHA-256 hash of the reset token (the raw token is only in the mail). */
  readonly tokenHash: string;
  readonly createdAt: Date;

  /**
   * Table name
   */
  static get tableName() {
    return 'password_resets';
  }

  /**
   * Timestamps columns.
   */
  get timestamps() {
    return ['createdAt'];
  }
}
