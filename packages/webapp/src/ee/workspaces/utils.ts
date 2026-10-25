import type { Workspace } from '@bigcapital/sdk-ts';

export function canSwitchWorkspace(
  workspace: Workspace,
  currentOrganizationId?: string | null,
) {
  return (
    workspace.organizationId !== currentOrganizationId &&
    workspace.isReady &&
    workspace.isActive &&
    !workspace.isBuildRunning &&
    !workspace.isDeleting
  );
}
