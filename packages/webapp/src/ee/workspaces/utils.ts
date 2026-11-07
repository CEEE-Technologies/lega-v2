import type { Workspace } from '@bigcapital/sdk-ts';

export function canSwitchWorkspace(
  workspace: Workspace,
  currentOrganizationId?: string | null,
) {
  return (
    workspace.organizationId !== currentOrganizationId &&
    workspace.isReady &&
    workspace.isActive &&
    // Opening it is refused (and a refusal signs the user out).
    !workspace.isUserInactive &&
    !workspace.isBuildRunning &&
    !workspace.isDeleting
  );
}
