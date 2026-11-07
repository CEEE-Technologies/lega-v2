import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Guards the pnpm patch of eventemitter2 (patches/eventemitter2@6.4.9.patch):
 * `emitAsync` waits for every listener before passing on the first error,
 * so no listener keeps writing to a transaction the caller is undoing.
 */
describe('EventEmitter2.emitAsync (patched)', () => {
  it('waits for the other listeners before rejecting', async () => {
    const emitter = new EventEmitter2();
    let siblingDone = false;
    emitter.on('saved', async () => {
      throw new Error('ledger failed');
    });
    emitter.on('saved', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      siblingDone = true;
    });
    await expect(emitter.emitAsync('saved')).rejects.toThrow('ledger failed');
    expect(siblingDone).toBe(true);
  });

  it('resolves with every listener result when all succeed', async () => {
    const emitter = new EventEmitter2();
    emitter.on('saved', async () => 1);
    emitter.on('saved', () => 2);
    await expect(emitter.emitAsync('saved')).resolves.toEqual([1, 2]);
  });
});
