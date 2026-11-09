import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Ability } from '@casl/ability';
import { PermissionGuard } from './Permission.guard';
import { RolesController } from './Roles.controller';
import { AbilitySubject, RoleAction } from './Roles.types';
import { AnyPermissionGuard } from './AnyPermission.guard';

describe('RolesController authorization', () => {
  const reflector = new Reflector();
  const guard = new PermissionGuard(reflector);

  const ctx = (handler: any, ability: Ability) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ ability }) }),
      getHandler: () => handler,
      getClass: () => RolesController,
    }) as any;

  const cases: Array<[string, string]> = [
    ['createRole', RoleAction.Create],
    ['editRole', RoleAction.Edit],
    ['deleteRole', RoleAction.Delete],
    ['getRole', RoleAction.View],
    ['getRolePermissionsSchema', RoleAction.View],
  ];

  it.each(cases)(
    '%s is denied (403) for a role without the Role permission',
    (method) => {
      const deny = new Ability([]);
      expect(() =>
        guard.canActivate(ctx(RolesController.prototype[method], deny)),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(cases)(
    '%s is allowed for a role that grants the matching Role permission',
    (method, action) => {
      const allow = new Ability([
        { action, subject: AbilitySubject.Role },
      ] as any);
      expect(
        guard.canActivate(ctx(RolesController.prototype[method], allow)),
      ).toBe(true);
    },
  );

  it('grants all Role operations to a manage-all (admin) ability', () => {
    const admin = new Ability([{ action: 'manage', subject: 'all' }] as any);
    for (const [method] of cases) {
      expect(
        guard.canActivate(ctx(RolesController.prototype[method], admin)),
      ).toBe(true);
    }
  });

  // F28: the role list is for role viewers and for user managers, who pick
  // a role when they invite someone.
  describe('getRoles (any of Role View, User Manage)', () => {
    const anyGuard = new AnyPermissionGuard(reflector);
    const handler = RolesController.prototype.getRoles;
    const check = (rules: any[]) =>
      anyGuard.canActivate(ctx(handler, new Ability(rules)));

    it('is denied without either permission', () => {
      expect(() => check([])).toThrow(ForbiddenException);
      expect(() =>
        check([{ action: RoleAction.Create, subject: AbilitySubject.Role }]),
      ).toThrow(ForbiddenException);
    });

    it('is allowed with Role View', () => {
      expect(
        check([{ action: RoleAction.View, subject: AbilitySubject.Role }]),
      ).toBe(true);
    });

    it('is allowed with User Manage', () => {
      expect(check([{ action: 'Manage', subject: AbilitySubject.User }])).toBe(
        true,
      );
    });

    it('passes the generic guard (the any-of guard does the check)', () => {
      expect(guard.canActivate(ctx(handler, new Ability([])))).toBe(true);
    });
  });
});
