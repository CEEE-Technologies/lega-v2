import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AllowAnyMember,
  RequiredPermission,
} from './RequirePermission.decorator';

export const ANY_PERMISSION_KEY = 'anyPermission';

/**
 * Lets the request through when the role holds any one of the route's
 * permissions. Runs after `AuthorizationGuard`, which attaches the ability
 * to the request.
 */
@Injectable()
export class AnyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.get<RequiredPermission[]>(
      ANY_PERMISSION_KEY,
      context.getHandler(),
    );
    const ability = context.switchToHttp().getRequest().ability;

    if (
      !rules?.length ||
      !ability ||
      !rules.some((rule) => ability.can(rule.ability, rule.subject))
    ) {
      throw new ForbiddenException('You do not have permission.');
    }
    return true;
  }
}

/**
 * The route needs any one of the given permissions. `AllowAnyMember` only
 * lets it past the generic `PermissionGuard`; `AnyPermissionGuard` does the
 * check.
 * @example
 * // The role list: for role editors and for user managers (who pick a role
 * // when they invite someone).
 * @RequireAnyPermission(
 *   { ability: RoleAction.View, subject: AbilitySubject.Role },
 *   { ability: UserAction.Manage, subject: AbilitySubject.User },
 * )
 */
export const RequireAnyPermission = (...rules: RequiredPermission[]) =>
  applyDecorators(
    SetMetadata(ANY_PERMISSION_KEY, rules),
    AllowAnyMember(),
    UseGuards(AnyPermissionGuard),
  );
