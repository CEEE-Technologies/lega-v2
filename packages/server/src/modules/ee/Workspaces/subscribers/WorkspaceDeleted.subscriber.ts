import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketGateway } from '@/modules/Socket/Socket.gateway';
import { events } from '@/common/events/events';

@Injectable()
export class WorkspaceDeletedSubscriber {
  constructor(private readonly socketGateway: SocketGateway) {}

  // Side effect (live-update notice): an error is logged and does not stop the save.
  @OnEvent(events.workspace.deleted, { suppressErrors: true })
  handleWorkspaceDeleted() {
    this.socketGateway.emitWorkspacesChanged();
  }
}
