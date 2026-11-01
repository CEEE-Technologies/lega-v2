import { Inject, Injectable } from '@nestjs/common';
import * as moment from 'moment';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import {
  IAcceptInviteEventPayload,
  ICheckInviteEventPayload,
} from '../Users.types';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { events } from '@/common/events/events';
import { hashPassword } from '@/modules/Auth/Auth.utils';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { SystemKnexConnection } from '@/modules/System/SystemDB/SystemDB.constants';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../Users.constants';
import { UserInvite } from '../models/InviteUser.model';
import { ModelObject } from 'objection';
import { InviteUserDto } from '../dtos/InviteUser.dto';

interface InviteAcceptResponseDto {
  inviteToken: { email: string; token: string; createdAt: Date };
  orgName: string;
}

@Injectable()
export class AcceptInviteUserService {
  constructor(
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(UserInvite.name)
    private readonly userInviteModel: typeof UserInvite,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
    @Inject(SystemKnexConnection)
    private readonly systemKnex: Knex,
  ) {}

  /**
   * Accept the received invite.
   * @param {string} token
   * @param {IInviteUserInput} inviteUserInput
   * @throws {ServiceErrors}
   * @returns {Promise<void>}
   */
  public async acceptInvite(
    token: string,
    inviteUserDTO: InviteUserDto,
  ): Promise<void> {
    // Hash the given password.
    const hashedPassword = await hashPassword(inviteUserDTO.password);

    // Accept the invite under a single system-database transaction.
    const { systemUser, tenant, inviteToken } =
      await this.systemKnex.transaction(async (trx) => {
        // Retrieve the invite token or throw not found error.
        const inviteToken = await this.getInviteTokenOrThrowError(token, trx);

        const invitedLogin = await this.systemUserModel
          .query(trx)
          .findById(inviteToken.userId)
          .throwIfNotFound();

        // An invite to someone who already has a login joins that login to
        // this organization. Its password and name stay as they are, and the
        // person proves it is theirs with the current password.
        const systemUser = invitedLogin.password
          ? await this.validateExistingLoginPassword(
              invitedLogin,
              inviteUserDTO.password,
            )
          : // Sets the invited user details after invite accepting.
            await this.systemUserModel
              .query(trx)
              .updateAndFetchById(inviteToken.userId, {
                ...inviteUserDTO,
                inviteAcceptedAt: moment().format('YYYY-MM-DD'),
                password: hashedPassword,
              });
        // Clear invite token by the given user id.
        await this.clearInviteTokensByUserId(inviteToken.userId, trx);

        // Retrieve the tenant to get the organizationId for CLS.
        const tenant = await this.tenantModel
          .query(trx)
          .findById(inviteToken.tenantId);

        // Link the invited user to the tenant as a member so they can sign in.
        const membership = await this.userTenantModel
          .query(trx)
          .findOne({ userId: systemUser.id, tenantId: inviteToken.tenantId });

        if (!membership) {
          await this.userTenantModel.query(trx).insert({
            userId: systemUser.id,
            tenantId: inviteToken.tenantId,
            role: 'member',
          });
        }
        return { systemUser, tenant, inviteToken };
      });
    // Set CLS values for tenant context before triggering sync events.
    this.cls.set('userId', systemUser.id);
    this.cls.set('organizationId', tenant.organizationId);

    // Triggers `onUserAcceptInvite` event.
    await this.eventEmitter.emitAsync(events.inviteUser.acceptInvite, {
      inviteToken,
      user: systemUser,
      inviteUserDTO,
    } as IAcceptInviteEventPayload);
  }

  /**
   * Checks the given password against an existing login.
   * @param {SystemUser} login - The existing login.
   * @param {string} password - The password typed on the invite page.
   * @returns {Promise<SystemUser>}
   */
  private async validateExistingLoginPassword(
    login: SystemUser,
    password: string,
  ): Promise<SystemUser> {
    if (!(await login.checkPassword(password))) {
      throw new ServiceError(
        ERRORS.EXISTING_LOGIN_PASSWORD_MISMATCH,
        'This email already has a LEGA login. Enter its current password to join.',
      );
    }
    return login;
  }

  /**
   * Validate the given invite token.
   * @param {string} token - the given token string.
   * @throws {ServiceError}
   */
  public async checkInvite(token: string): Promise<InviteAcceptResponseDto> {
    const inviteToken = await this.getInviteTokenOrThrowError(token);

    // Find the tenant that associated to the given token.
    const tenant = await this.tenantModel
      .query()
      .findById(inviteToken.tenantId)
      .withGraphFetched('metadata');

    // Triggers `onUserCheckInvite` event.
    await this.eventEmitter.emitAsync(events.inviteUser.checkInvite, {
      inviteToken,
      tenant,
    } as ICheckInviteEventPayload);

    // Explicitly convert to plain object to ensure all fields are serialized
    const result = {
      inviteToken: {
        email: inviteToken.email,
        token: inviteToken.token,
        createdAt: inviteToken.createdAt,
      },
      orgName: tenant.metadata.name,
    };
    return result;
  }

  /**
   * Retrieve invite model from the given token or throw error.
   * @param {string} token - Then given token string.
   * @throws {ServiceError}
   * @returns {Invite}
   */
  private getInviteTokenOrThrowError = async (
    token: string,
    trx?: Knex.Transaction,
  ): Promise<ModelObject<UserInvite>> => {
    const inviteToken = await this.userInviteModel
      .query(trx)
      .modify('notExpired')
      .findOne('token', token);

    if (!inviteToken) {
      throw new ServiceError(ERRORS.INVITE_TOKEN_INVALID);
    }
    return inviteToken;
  };

  /**
   * Validate the given user email and phone number uniquine.
   * @param {IInviteUserInput} inviteUserInput
   */
  private validateUserPhoneNumberNotExists = async (
    phoneNumber: string,
  ): Promise<void> => {
    const foundUser = await SystemUser.query().findOne({ phoneNumber });

    if (foundUser) {
      throw new ServiceError(ERRORS.PHONE_NUMBER_EXISTS);
    }
  };

  /**
   * Clear invite tokens of the given user id.
   * @param {number} userId - User id.
   */
  private clearInviteTokensByUserId = async (
    userId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.userInviteModel.query(trx).where('user_id', userId).delete();
  };
}
