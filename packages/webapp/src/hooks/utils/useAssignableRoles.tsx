import React from 'react';
import { useAbilityContext } from './useAbilityContext';

interface RoleLike {
  id?: number | string;
  slug?: string | null;
}

export const ADMIN_ROLE_SLUG = 'admin';

/**
 * Whether the signed-in user is an admin of the current organization.
 * Admins (and the owner) have every permission.
 */
export const useIsAdmin = (): boolean => {
  const ability = useAbilityContext();
  return ability.can('manage', 'all');
};

/**
 * The roles the signed-in user may give. Only the owner and admins can give
 * the Admin role; the server refuses it for anyone else. The role a user
 * already has stays in the list so the form can show it.
 * @param {T[]} roles - All roles.
 * @param {number | string} currentRoleId - The role the user has now.
 */
export const useAssignableRoles = <T extends RoleLike>(
  roles: T[] | undefined,
  currentRoleId?: number | string | null,
): T[] => {
  const isAdmin = useIsAdmin();

  return React.useMemo(
    () =>
      (roles ?? []).filter(
        (role) =>
          isAdmin ||
          role.slug !== ADMIN_ROLE_SLUG ||
          (currentRoleId != null && String(role.id) === String(currentRoleId)),
      ),
    [roles, isAdmin, currentRoleId],
  );
};
