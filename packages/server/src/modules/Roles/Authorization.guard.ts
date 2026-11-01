import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  Optional,
} from '@nestjs/common';
import { Ability } from '@casl/ability';
import { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import {
  cacheAbility,
  getAbilityForRole,
  getCachedAbility,
} from './TenantAbilities';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { TenantUser } from '../Tenancy/TenancyModels/models/TenantUser.model';
import { TenantModel } from '../System/models/TenantModel';
import { UserTenant } from '../System/models/UserTenant.model';

/**
 * Authorization guard for checking user abilities
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly clsService: ClsService,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    @Optional()
    @Inject(TenantModel.name)
    private readonly tenantModel?: typeof TenantModel,

    @Optional()
    @Inject(UserTenant.name)
    private readonly userTenantModel?: typeof UserTenant,
  ) {}

  /**
   * Checks if the user has the required abilities to access the route
   * @param context - The execution context
   * @returns A boolean indicating if the user can access the route
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = this.clsService.get<number>('userId');
    const organizationId = this.clsService.get<string>('organizationId');
    const isCacheable = organizationId != null && userId != null;

    if (isCacheable) {
      const cachedAbility = getCachedAbility(organizationId, userId);
      if (cachedAbility) {
        (request as any).ability = cachedAbility;
        return true;
      }
    }
    const { ability, cacheable } = await this.getAbilityForUser();
    (request as any).ability = ability;

    if (isCacheable && cacheable) {
      cacheAbility(organizationId, userId, ability);
    }
    return true;
  }

  async getAbilityForUser(): Promise<{ ability: Ability; cacheable: boolean }> {
    const userId = this.clsService.get('userId');
    const organizationId = this.clsService.get<string>('organizationId');

    // The organization database doesn't exist until it is built. Until then
    // only the owner who signed up may act on it, as Admin.
    if (this.tenantModel && organizationId) {
      const tenant = await this.tenantModel.query().findOne({ organizationId });

      if (tenant && !tenant.initializedAt) {
        const membership = await this.userTenantModel
          ?.query()
          .findOne({ userId, tenantId: tenant.id });
        const isOwner = membership?.role === 'owner';

        return {
          ability: getAbilityForRole({ slug: isOwner ? 'admin' : null }),
          cacheable: false,
        };
      }
    }
    const tenantUser = await this.tenantUserModel()
      .query()
      .findOne('systemUserId', userId)
      .withGraphFetched('role.permissions');

    // No user (or no role) in this organization: no permissions at all.
    if (!tenantUser?.role) {
      return { ability: new Ability([]), cacheable: false };
    }
    return { ability: getAbilityForRole(tenantUser.role), cacheable: true };
  }
}
