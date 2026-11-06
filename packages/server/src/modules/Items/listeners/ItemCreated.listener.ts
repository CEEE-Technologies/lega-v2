import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ItemCreatedEvent } from '../events/ItemCreated.event';

@Injectable()
export class ItemCreatedListener {
  // Side effect (unused sample listener, only logs): an error is logged and does not stop the save.
  @OnEvent('order.created', { suppressErrors: true })
  handleItemCreatedEvent(event: ItemCreatedEvent) {
    // handle and process "OrderCreatedEvent" event
    console.log(event);
  }
}
