import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_ROUTE } from '../Auth/Auth.constants';
import { IS_TENANT_AGNOSTIC } from '../Tenancy/TenancyGlobal.guard';
import { AuthorizationGuard } from './Authorization.guard';
import { PermissionGuard } from './Permission.guard';
import {
  ALLOW_ANY_MEMBER_KEY,
  REQUIRED_PERMISSION_KEY,
  RequiredPermission,
} from './RequirePermission.decorator';
import { AbilitySchema } from './AbilitySchema';
import { getInvalidPermissions } from './utils';
import { CONTACT_PERMISSION_KEY } from '../Contacts/ContactPermission.guard';

/**
 * Routes that anyone may call without signing in. Each one checks its own
 * secret (signature, token or link id). Keep this list short.
 */
const PUBLIC_ROUTES = [
  'POST /auth/signin',
  'POST /auth/signup',
  'POST /auth/signup/verify',
  'POST /auth/send_reset_password',
  'POST /auth/reset_password/:token',
  'GET /auth/meta',
  'POST /invite/accept/:token',
  'GET /invite/check/:token',
  'POST /webhooks/stripe',
  'POST /banking/plaid/webhooks',
  'POST /webhooks/lemon',
  'GET /payment-links/:paymentLinkId/invoice',
  'POST /payment-links/:paymentLinkId/stripe_checkout_session',
  'GET /payment-links/:paymentLinkId/invoice/pdf',
  'GET /system_db',
];

/**
 * Routes about the signed-in login itself rather than one organization, so
 * there is no role to check. Their services check ownership themselves.
 */
const TENANT_AGNOSTIC_ROUTES = [
  'POST /auth/signup/verify/resend',
  'GET /auth/account',
  'GET /workspaces',
  'POST /workspaces',
  'GET /workspaces/build/:buildJobId',
  'PUT /workspaces/default',
];

/**
 * Routes that act on another organization named in the path, and refuse
 * anyone who isn't that organization's owner in their service.
 */
const OWNER_CHECKED_ROUTES = [
  'DELETE /workspaces/:organizationId',
  'PUT /workspaces/:organizationId/inactivate',
  'PUT /workspaces/:organizationId/activate',
];

const MODULES_DIR = path.join(__dirname, '..');

const findControllerFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findControllerFiles(fullPath);
    return /\.controllers?\.ts$/.test(entry.name) ? [fullPath] : [];
  });

const joinPath = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((part) => (part || '').split('/'))
    .filter(Boolean)
    .join('/');

interface RouteInfo {
  key: string;
  file: string;
  isPublic: boolean;
  isTenantAgnostic: boolean;
  hasGuards: boolean;
  hasRule: boolean;
  /** The permissions a role needs for the route (none for Admin-only). */
  grants: RequiredPermission[];
}

/**
 * The permissions a role must be able to hold to use a route. Admin-only
 * routes (`manage all`) need none; contact routes need the Customer and the
 * Vendor permission.
 */
const getGrants = (
  rule: RequiredPermission | undefined,
  contactAction: string | undefined,
): RequiredPermission[] => {
  const grants: RequiredPermission[] = [];
  if (rule && !(rule.ability === 'manage' && rule.subject === 'all')) {
    grants.push(rule);
  }
  if (contactAction) {
    grants.push({ ability: contactAction, subject: 'Customer' });
    grants.push({ ability: contactAction, subject: 'Vendor' });
  }
  return grants;
};

const collectRoutes = (): RouteInfo[] => {
  const routes: RouteInfo[] = [];

  for (const file of findControllerFiles(MODULES_DIR)) {
    const exported = require(file);

    for (const controller of Object.values<any>(exported)) {
      if (typeof controller !== 'function') continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller);
      if (controllerPath === undefined) continue;

      const classGuards =
        Reflect.getMetadata(GUARDS_METADATA, controller) || [];
      const proto = controller.prototype;

      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        if (method === undefined || routePath === undefined) continue;

        const read = (key: string) =>
          Reflect.getMetadata(key, handler) ??
          Reflect.getMetadata(key, controller);
        const guards = [
          ...classGuards,
          ...(Reflect.getMetadata(GUARDS_METADATA, handler) || []),
        ];
        const paths = ([] as string[]).concat(controllerPath);

        for (const base of paths) {
          routes.push({
            key: `${RequestMethod[method]} ${joinPath(base, routePath)}`,
            file: path.relative(MODULES_DIR, file),
            isPublic: !!read(IS_PUBLIC_ROUTE),
            isTenantAgnostic: !!read(IS_TENANT_AGNOSTIC),
            hasGuards:
              guards.includes(AuthorizationGuard) &&
              guards.includes(PermissionGuard),
            hasRule: !!(
              read(REQUIRED_PERMISSION_KEY) || read(ALLOW_ANY_MEMBER_KEY)
            ),
            grants: getGrants(
              read(REQUIRED_PERMISSION_KEY),
              read(CONTACT_PERMISSION_KEY),
            ),
          });
        }
      }
    }
  }
  return routes;
};

describe('Route permissions coverage', () => {
  let routes: RouteInfo[];

  beforeAll(() => {
    routes = collectRoutes();
  });

  it('finds the server routes', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('every organization route has the permission guards and a rule', () => {
    const missing = routes
      .filter((route) => !route.isPublic && !route.isTenantAgnostic)
      .filter((route) => !OWNER_CHECKED_ROUTES.includes(route.key))
      .filter((route) => !route.hasGuards || !route.hasRule)
      .map(
        (route) =>
          `${route.key} (${route.file})${route.hasGuards ? '' : ' no guards'}${
            route.hasRule ? '' : ' no rule'
          }`,
      );
    expect(missing).toEqual([]);
  });

  it('every permission a route needs can be granted to a role', () => {
    // A rule the roles schema doesn't define can't be saved on a role, so
    // the route would be Admin only by accident.
    const notGrantable = routes.flatMap((route) =>
      getInvalidPermissions(
        AbilitySchema,
        route.grants.map((grant) => ({ ...grant, value: true })),
      ).map((grant) => `${route.key}: ${grant.ability} ${grant.subject}`),
    );
    expect(notGrantable).toEqual([]);
  });

  it('only the listed routes are public', () => {
    const publicRoutes = routes
      .filter((route) => route.isPublic)
      .map((route) => route.key)
      .sort();
    expect(publicRoutes).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('only the listed routes skip the organization check', () => {
    const agnosticRoutes = routes
      .filter((route) => route.isTenantAgnostic && !route.isPublic)
      .map((route) => route.key)
      .sort();
    expect(agnosticRoutes).toEqual([...TENANT_AGNOSTIC_ROUTES].sort());
  });
});
