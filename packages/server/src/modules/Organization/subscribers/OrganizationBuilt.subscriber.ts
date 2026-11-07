import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketGateway } from '@/modules/Socket/Socket.gateway';
import { events } from '@/common/events/events';

@Injectable()
export class OrganizationBuiltSubscriber {
  constructor(private readonly socketGateway: SocketGateway) {}

  // Side effect (live-update notice): an error is logged and does not stop the save.
  @OnEvent(events.organization.built, { suppressErrors: true })
  handleOrganizationBuilt() {
    this.socketGateway.emitWorkspacesChanged();
  }
}
