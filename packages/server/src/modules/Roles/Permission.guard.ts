import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  ALLOW_ANY_MEMBER_KEY,
  REQUIRED_PERMISSION_KEY,
  RequiredPermission,
} from './RequirePermission.decorator';

/**
 * Guard that checks CASL `ability` on the request (attached by AuthorizationGuard).
 *
 * A route with no `RequirePermission` rule is Admin only, unless it is marked
 * with `AllowAnyMember`. A missing rule never opens a route to everyone.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const requiredPermission =
      this.reflector.getAllAndOverride<RequiredPermission>(
        REQUIRED_PERMISSION_KEY,
        targets,
      );
    const allowAnyMember = this.reflector.getAllAndOverride<boolean>(
      ALLOW_ANY_MEMBER_KEY,
      targets,
    );
    if (!requiredPermission && allowAnyMember) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const ability = (request as any).ability;

    if (!ability) {
      throw new ForbiddenException(
        'Ability instance not found. Ensure AuthorizationGuard is applied.',
      );
    }
    const { ability: action, subject } = requiredPermission || {
      ability: 'manage',
      subject: 'all',
    };

    if (!ability.can(action, subject)) {
      throw new ForbiddenException(
        `You do not have permission to ${action} ${subject}`,
      );
    }
    return true;
  }
}
