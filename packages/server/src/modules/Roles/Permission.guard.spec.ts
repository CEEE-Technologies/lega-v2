import { Ability } from '@casl/ability';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './Permission.guard';
import {
  AllowAnyMember,
  RequireAdmin,
  RequirePermission,
} from './RequirePermission.decorator';
import { getAbilityForRole } from './TenantAbilities';

class TestController {
  @RequirePermission('View', 'Item')
  ruled() {}

  @RequireAdmin()
  adminOnly() {}

  @AllowAnyMember()
  anyMember() {}

  noRule() {}
}

const admin = getAbilityForRole({ slug: 'admin' });
const viewer = getAbilityForRole({
  slug: 'viewer',
  permissions: [{ subject: 'Item', ability: 'View', value: true }],
});

const run = (handler: keyof TestController, ability: Ability) => {
  const guard = new PermissionGuard(new Reflector());
  const context: any = {
    getHandler: () => TestController.prototype[handler],
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => ({ ability }) }),
  };
  return () => guard.canActivate(context);
};

describe('PermissionGuard', () => {
  it('allows a route whose rule the role has', () => {
    expect(run('ruled', viewer)()).toBe(true);
  });

  it('refuses a route whose rule the role lacks', () => {
    const noItems = getAbilityForRole({ slug: 'viewer', permissions: [] });
    expect(run('ruled', noItems)).toThrow(ForbiddenException);
  });

  it('lets only Admin use an admin-only route', () => {
    expect(run('adminOnly', admin)()).toBe(true);
    expect(run('adminOnly', viewer)).toThrow(ForbiddenException);
  });

  it('treats a route with no rule as admin only (fails closed)', () => {
    expect(run('noRule', admin)()).toBe(true);
    expect(run('noRule', viewer)).toThrow(ForbiddenException);
  });

  it('lets any member use an any-member route', () => {
    const nothing = new Ability([]);
    expect(run('anyMember', nothing)()).toBe(true);
  });

  it('a role permission named "all" does not count as Admin', () => {
    const fake = getAbilityForRole({
      slug: 'custom',
      permissions: [{ subject: 'Item', ability: 'manage', value: true }],
    });
    expect(run('adminOnly', fake)).toThrow(ForbiddenException);
  });
});
