import { registerUnhandledRejectionLogger } from './unhandled-rejection-logger';

describe('registerUnhandledRejectionLogger', () => {
  it('logs an unhandled rejection', () => {
    const logger = { error: jest.fn() };
    const remove = registerUnhandledRejectionLogger(logger);
    try {
      process.emit(
        'unhandledRejection' as any,
        new Error('SMTP down') as any,
        Promise.resolve() as any,
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('SMTP down'),
      );
    } finally {
      remove();
    }
    logger.error.mockClear();
    process.emit('unhandledRejection' as any, 'later' as any, null as any);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
