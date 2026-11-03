import { Logger } from '@nestjs/common';

/**
 * Logs promise rejections nobody handled instead of letting Node stop the
 * server. Without a listener, Node exits on an unhandled rejection, so one
 * stray promise (for example a mail that fails to send) would take every
 * company offline.
 * @returns {() => void} Removes the listener.
 */
export const registerUnhandledRejectionLogger = (
  logger: Pick<Logger, 'error'> = new Logger('UnhandledRejection'),
) => {
  const listener = (reason: unknown) => {
    const detail =
      reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`Unhandled promise rejection: ${detail}`);
  };
  process.on('unhandledRejection', listener);
  return () => {
    process.off('unhandledRejection', listener);
  };
};
