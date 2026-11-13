import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { ITenantUserEditedPayload } from '../Users.types';
import { EditUserDto } from '../dtos/EditUser.dto';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../Users.constants';
import { ModelObject } from 'objection';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { Role } from '@/modules/Roles/models/Role.model';
import { TenantUserOwnerService } from './TenantUserOwner.service';
import { AdminAccessService } from '@/modules/Roles/AdminAccess.service';

const normalizeEmail = (email: string | null | undefined) =>
  (email || '').trim().toLowerCase();

@Injectable()
export class EditUserService {
  constructor(
    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    @Inject(Role.name)
    private readonly roleModel: TenantModelProxy<typeof Role>,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    private readonly eventEmitter: EventEmitter2,
    private readonly tenancyContext: TenancyContext,
    private readonly tenantUserOwner: TenantUserOwnerService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  /**
   * Edits the given user of the current organization.
   * Only the user themselves may change their email, because the email is
   * their login for every organization they belong to.
   * @param {number} userId - User id.
   * @param {IUserDTO} editUserDTO - Edit user DTO.
   * @return {Promise<ISystemUser>}
   */
  public async editUser(
    userId: number,
    editUserDTO: EditUserDto,
  ): Promise<any> {
    const authorizedUser = await this.tenancyContext.getSystemUser();

    // Retrieve the tenant user or throw not found service error.
    const oldTenantUser = await this.tenantUserModel()
      .query()
      .findById(userId)
      .throwIfNotFound();

    const isSelf = oldTenantUser.systemUserId === authorizedUser.id;

    // Only the owner may edit the owner.
    await this.tenantUserOwner.throwIfOwnerOfSomeoneElse(
      oldTenantUser,
      authorizedUser.id,
    );
    // Validate cannot mutate the authorized user.
    this.validateMutateRoleNotAuthorizedUser(
      oldTenantUser,
      editUserDTO,
      authorizedUser,
    );
    // Validate the given role exists.
    await this.validateRoleExists(editUserDTO.roleId);

    // Only the owner and admins can make someone an admin, or change an
    // admin's role.
    await this.validateAdminRoleChange(
      oldTenantUser.roleId,
      editUserDTO.roleId,
    );

    const isEmailChanged =
      normalizeEmail(editUserDTO.email) !== normalizeEmail(oldTenantUser.email);

    if (isEmailChanged) {
      if (!isSelf) {
        throw new ServiceError(
          ERRORS.CANNOT_CHANGE_OTHER_USER_EMAIL,
          'You can only change your own email.',
        );
      }
      // The email is the user's login, so it must be unique across logins.
      await this.validateUserEmailUniquiness(editUserDTO.email, userId);
      await this.validateLoginEmailUniquiness(
        editUserDTO.email,
        authorizedUser.id,
      );
    }
    // Updates the tenant user.
    const tenantUser = await this.tenantUserModel()
      .query()
      .updateAndFetchById(userId, {
        firstName: editUserDTO.firstName,
        lastName: editUserDTO.lastName,
        email: isEmailChanged ? editUserDTO.email : oldTenantUser.email,
        roleId: editUserDTO.roleId,
      });
    // Triggers `onTenantUserEdited` event.
    await this.eventEmitter.emitAsync(events.tenantUser.onEdited, {
      userId,
      editUserDTO,
      tenantUser,
      oldTenantUser,
    } as ITenantUserEditedPayload);

    return tenantUser;
  }

  /**
   * Validate the given role exists.
   * @param {number} roleId
   */
  async validateRoleExists(roleId: number) {
    const role = await this.roleModel().query().findById(roleId);

    if (!role) {
      throw new ServiceError(ERRORS.ROLE_NOT_FOUND, 'Role not found.');
    }
  }

  /**
   * Throws unless the signed-in user may make the role change: taking away
   * or giving the Admin role needs an admin; giving another role needs its
   * permissions (a non-admin can't give more than they hold).
   * @param {number} oldRoleId - The user's role now.
   * @param {number} newRoleId - The role asked for.
   */
  async validateAdminRoleChange(oldRoleId: number, newRoleId: number) {
    if (oldRoleId === newRoleId) return;

    if (await this.adminAccess.isAdminRole(oldRoleId)) {
      await this.adminAccess.throwUnlessAdmin();
    }
    // The Admin role needs an admin; any other role needs its permissions.
    await this.adminAccess.throwUnlessMayGiveRole(newRoleId);
  }

  /**
   * Validate the given user email should be unique in the storage.
   * @param {string} email - User email.
   * @param {number} userId - User id.
   */
  async validateUserEmailUniquiness(email: string, userId: number) {
    const userByEmail = await this.tenantUserModel()
      .query()
      .findOne('email', email)
      .whereNot('id', userId);

    if (userByEmail) {
      throw new ServiceError(ERRORS.EMAIL_ALREADY_EXISTS);
    }
  }

  /**
   * Validate no other login uses the given email.
   * @param {string} email - New email.
   * @param {number} systemUserId - The login being changed.
   */
  async validateLoginEmailUniquiness(email: string, systemUserId: number) {
    const loginByEmail = await this.systemUserModel
      .query()
      .findOne('email', email)
      .whereNot('id', systemUserId);

    if (loginByEmail) {
      throw new ServiceError(ERRORS.EMAIL_ALREADY_EXISTS);
    }
  }

  /**
   * Validate the authorized user cannot mutate its role.
   * @param {ITenantUser} oldTenantUser - Old tenant user.
   * @param {IEditUserDTO} editUserDTO - Edit user dto.
   * @param {ISystemUser} authorizedUser - Authorized user.
   */
  validateMutateRoleNotAuthorizedUser(
    oldTenantUser: ModelObject<TenantUser>,
    editUserDTO: EditUserDto,
    authorizedUser: ModelObject<SystemUser>,
  ) {
    if (
      authorizedUser.id === oldTenantUser.systemUserId &&
      editUserDTO.roleId !== oldTenantUser.roleId
    ) {
      throw new ServiceError(ERRORS.CANNOT_AUTHORIZED_USER_MUTATE_ROLE);
    }
  }
}
