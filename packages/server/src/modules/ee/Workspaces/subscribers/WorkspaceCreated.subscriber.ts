import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { events } from '@/common/events/events';
import { IWorkspaceCreatedEventPayload } from '../Workspaces.types';

@Injectable()
export class WorkspaceCreatedSubscriber {
  constructor() {}

  // Side effect (runs after the workspace is saved): an error is logged and does not stop the save.
  @OnEvent(events.workspace.created, { suppressErrors: true })
  async handleWorkspaceCreated({
    tenantId: _tenantId,
    organizationId: _organizationId,
    userId: _userId,
    buildDTO: _buildDTO,
  }: IWorkspaceCreatedEventPayload) {
    // Handle any setup that needs to happen after workspace creation.
    // This runs after system-level metadata is saved in tenants_metadata.
    // Note: The tenant database is not ready yet - the build job will handle that later.
  }
}
