import { ClsService } from 'nestjs-cls';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { ModelObject } from 'objection';
import { JwtPayload } from '../Auth.interfaces';
import { JWT_ISSUER, JWT_AUDIENCE } from '../Auth.constants';
import { InvalidEmailPasswordException } from '../exceptions/InvalidEmailPassword.exception';
import { UserNotFoundException } from '../exceptions/UserNotFound.exception';

@Injectable()
export class AuthSigninService {
  constructor(
    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    private readonly jwtService: JwtService,
    private readonly clsService: ClsService,

    @Inject(TenantUser.name)
    private readonly tenantUserModel?: TenantModelProxy<typeof TenantUser>,
  ) {}

  /**
   * Validates the given email and password.
   * @param {string} email - Signin email address.
   * @param {string} password - Signin password.
   * @returns {Promise<ModelObject<SystemUser>>}
   */
  async signin(
    email: string,
    password: string,
  ): Promise<ModelObject<SystemUser>> {
    let user: SystemUser;

    try {
      user = await this.systemUserModel
        .query()
        .findOne({ email })
        .throwIfNotFound();
    } catch (_err) {
      throw new InvalidEmailPasswordException(email);
    }
    if (!(await user.checkPassword(password))) {
      throw new InvalidEmailPasswordException(email);
    }
    return user;
  }

  /**
   * Verifies the given jwt payload.
   * @param {JwtPayload} payload
   * @returns {Promise<any>}
   */
  async verifyPayload(payload: JwtPayload): Promise<any> {
    if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
      throw new UnauthorizedException('Invalid token claims.');
    }
    let user: SystemUser;
    try {
      user = await this.systemUserModel
        .query()
        .findOne({ id: Number(payload.sub) })
        .throwIfNotFound();
    } catch (_error) {
      throw new UserNotFoundException(String(payload.sub));
    }
    if (!user) {
      throw new UserNotFoundException(String(payload.sub));
    }
    // A password reset raises the session version, which ends every session
    // made before it. Tokens from before versions existed count as 0.
    if ((payload.sv ?? 0) !== (user.sessionVersion ?? 0)) {
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
    this.clsService.set('userId', user.id);
    return payload;
  }

  /**
   * Resolves which tenant a user should sign in to:
   *  1. Their explicit default workspace (`defaultTenantId`).
   *  2. Their initial/legacy workspace (`tenantId`).
   *  3. The first active workspace they have a membership in.
   * Workspaces where the user was deactivated are skipped.
   * Returns null when the user has no active workspace available.
   */
  async resolveSigninTenant(user: SystemUser): Promise<TenantModel | null> {
    if (user.defaultTenantId) {
      const tenant = await this.tryGetActiveTenantForUser(
        user.id,
        user.defaultTenantId,
      );
      if (tenant) return tenant;
    }
    if (user.tenantId) {
      const tenant = await this.tryGetActiveTenantForUser(
        user.id,
        user.tenantId,
      );
      if (tenant) return tenant;
    }
    const memberships = await this.userTenantModel
      .query()
      .where('userId', user.id)
      .withGraphFetched('tenant')
      .orderBy('id', 'asc');

    for (const membership of memberships) {
      if (!membership.tenant?.isActive) continue;
      if (await this.isUserActiveInTenant(user.id, membership.tenant)) {
        return membership.tenant;
      }
    }
    return null;
  }

  /**
   * Whether the user is active in the given workspace. Deactivating a user
   * blocks them in that workspace only. Requests are checked again by the
   * tenancy guard; this only picks which workspace opens after sign-in.
   * @param {number} userId - System user id.
   * @param {TenantModel} tenant
   * @returns {Promise<boolean>}
   */
  private async isUserActiveInTenant(
    userId: number,
    tenant: TenantModel,
  ): Promise<boolean> {
    if (!tenant.initializedAt || !this.tenantUserModel) return true;

    const previousOrganizationId = this.clsService.get?.('organizationId');
    this.clsService.set('organizationId', tenant.organizationId);
    try {
      const tenantUser = await this.tenantUserModel()
        .query()
        .findOne({ systemUserId: userId });

      return !(tenantUser && tenantUser.active != null && !tenantUser.active);
    } catch (_error) {
      return true;
    } finally {
      this.clsService.set('organizationId', previousOrganizationId);
    }
  }

  /**
   * Returns the tenant only when the user is a member and the tenant is active.
   */
  private async tryGetActiveTenantForUser(
    userId: number,
    tenantId: number,
  ): Promise<TenantModel | null> {
    const membership = await this.userTenantModel
      .query()
      .where({ userId, tenantId })
      .withGraphFetched('tenant')
      .first();

    if (!membership?.tenant?.isActive) return null;
    if (!(await this.isUserActiveInTenant(userId, membership.tenant))) {
      return null;
    }
    return membership.tenant;
  }

  /**
   *
   * @param {SystemUser} user
   * @param {boolean} rememberMe - Extends the token lifetime when the user opted to stay signed in.
   * @returns {string}
   */
  signToken(user: SystemUser, rememberMe = false): string {
    const payload = {
      sub: String(user.id),
      sv: user.sessionVersion ?? 0,
    };
    const expiresIn = rememberMe ? '30d' : '1d';
    return this.jwtService.sign(payload, {
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }
}
