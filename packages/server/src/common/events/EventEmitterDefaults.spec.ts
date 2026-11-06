import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
} from '@nestjs/event-emitter';

/**
 * Guards the `@nestjs/event-emitter` patch (patches/@nestjs__event-emitter@*.patch).
 *
 * The library catches handler errors by default and only logs them, so a
 * failing ledger write or check could not stop a save. The patch flips the
 * default: errors reach the caller unless a handler opts out with
 * `{ suppressErrors: true }`. If a library upgrade drops the patch, this
 * test fails.
 */
@Injectable()
class ThrowingHandlers {
  @OnEvent('test.default')
  onDefault() {
    throw new Error('default handler failed');
  }

  @OnEvent('test.asyncDefault')
  async onAsyncDefault() {
    throw new Error('async handler failed');
  }

  @OnEvent('test.suppressed', { suppressErrors: true })
  onSuppressed() {
    throw new Error('suppressed handler failed');
  }

  @OnEvent('test.notSuppressed', { suppressErrors: false })
  onNotSuppressed() {
    throw new Error('not suppressed handler failed');
  }
}

describe('@nestjs/event-emitter error default (patched)', () => {
  let emitter: EventEmitter2;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [ThrowingHandlers],
    }).compile();
    await moduleRef.init();
    emitter = moduleRef.get(EventEmitter2);
  });

  it('passes a handler error to the caller when no option is given', async () => {
    await expect(emitter.emitAsync('test.default')).rejects.toThrow(
      'default handler failed',
    );
  });

  it('passes an async handler error to the caller when no option is given', async () => {
    await expect(emitter.emitAsync('test.asyncDefault')).rejects.toThrow(
      'async handler failed',
    );
  });

  it('only logs the error when the handler opts in with suppressErrors: true', async () => {
    await expect(emitter.emitAsync('test.suppressed')).resolves.toBeDefined();
  });

  it('still passes the error on with an explicit suppressErrors: false', async () => {
    await expect(emitter.emitAsync('test.notSuppressed')).rejects.toThrow(
      'not suppressed handler failed',
    );
  });
});
