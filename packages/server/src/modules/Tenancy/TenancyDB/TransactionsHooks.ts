/**
 * Enumeration that represents transaction isolation levels for use with the {@link Transactional} annotation
 */
export enum IsolationLevel {
  /**
   * A constant indicating that dirty reads, non-repeatable reads and phantom reads can occur.
   */
  READ_UNCOMMITTED = 'read uncommitted',
  /**
   * A constant indicating that dirty reads are prevented; non-repeatable reads and phantom reads can occur.
   */
  READ_COMMITTED = 'read committed',
  /**
   * A constant indicating that dirty reads and non-repeatable reads are prevented; phantom reads can occur.
   */
  REPEATABLE_READ = 'repeatable read',
  /**
   * A constant indicating that dirty reads, non-repeatable reads and phantom reads are prevented.
   */
  SERIALIZABLE = 'serializable',
}

/**
 * @param {any} maybeTrx
 * @returns {maybeTrx is import('objection').TransactionOrKnex & { executionPromise: Promise<any> }}
 */
function checkIsTransaction(maybeTrx) {
  return Boolean(maybeTrx && maybeTrx.executionPromise);
}

/**
 * Wait for a transaction to be complete.
 * @param {import('objection').TransactionOrKnex} [trx]
 */
export async function waitForTransaction(trx) {
  return Promise.resolve(checkIsTransaction(trx) ? trx.executionPromise : null);
}

/**
 * After-commit work queued while a savepoint step runs (see
 * `withSavepoint`): one list per open step, innermost last. A failed step's
 * list is dropped with its writes; a successful step hands its list to the
 * step around it, or to the transaction itself.
 */
const STEP_HOOKS = Symbol('lega.stepAfterCommitHooks');

type StepHooks = Array<Array<() => unknown>>;

/**
 * Starts collecting the after-commit work of a savepoint step.
 * @param {import('objection').TransactionOrKnex} trx
 */
export function openStepHooks(trx) {
  if (!trx[STEP_HOOKS]) trx[STEP_HOOKS] = [] as StepHooks;
  (trx[STEP_HOOKS] as StepHooks).push([]);
}

/**
 * Ends the innermost savepoint step: keeps its after-commit work when the
 * step succeeded, and drops it when the step was undone.
 * @param {import('objection').TransactionOrKnex} trx
 * @param {boolean} keep - Whether the step succeeded.
 */
export function closeStepHooks(trx, keep: boolean) {
  const hooks = (trx[STEP_HOOKS] as StepHooks | undefined)?.pop() ?? [];
  if (!keep) return;
  hooks.forEach((callback) => runAfterTransaction(trx, callback));
}

/** The after-commit work that has not finished yet. */
const pendingAfterCommitWork = new Set<Promise<unknown>>();

/**
 * Run a callback when the transaction is done.
 * @param {import('objection').TransactionOrKnex | undefined} trx
 * @param {Function} callback
 */
export function runAfterTransaction(trx, callback) {
  // Inside a savepoint step the work waits for the step to succeed first.
  const steps = trx?.[STEP_HOOKS] as StepHooks | undefined;
  if (steps && steps.length > 0) {
    steps[steps.length - 1].push(callback);
    return;
  }
  const work = waitForTransaction(trx).then(
    () => {
      // If transaction success, then run action
      // Log instead of re-throwing: an error thrown from a timer is an
      // uncaught exception and would stop the whole server.
      return Promise.resolve()
        .then(() => callback())
        .catch((error) => {
          console.error(
            '[runAfterTransaction] after-commit hook failed:',
            error,
          );
        });
    },
    () => {
      // The transaction was rolled back: skip the hook.
    },
  );
  pendingAfterCommitWork.add(work);
  work.finally(() => pendingAfterCommitWork.delete(work));
}

/**
 * Waits until the after-commit work queued so far (and any it queues in
 * turn) has finished. A process that exits right after a save, such as a
 * CLI repair command, calls this before closing the app: otherwise the
 * work (adding the cost recompute job, the analytics delta, the audit row)
 * is cut off, although the save itself committed. Gives up after
 * `timeoutMs`, so a transaction left open can't hang a shutdown.
 */
export async function settleAfterCommitWork(
  timeoutMs: number = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pendingAfterCommitWork.size > 0 && Date.now() < deadline) {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadline - Date.now());
    });
    // A transaction still open at the deadline doesn't hold up shutdown.
    await Promise.race([
      Promise.allSettled([...pendingAfterCommitWork]),
      timeout,
    ]);
    clearTimeout(timer);
  }
}
