import {
  assertBullBoardConfig,
  BULL_BOARD_NO_CREDENTIALS_MESSAGE,
  createBullBoardAuthMiddleware,
} from './bull-board-auth.middleware';

const run = (
  middleware: ReturnType<typeof createBullBoardAuthMiddleware>,
  authorization?: string,
) => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const next = jest.fn();
  middleware({ headers: { authorization } } as any, res, next);
  return { res, next };
};

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('Bull Board auth middleware', () => {
  it('answers 404 when Bull Board is off', () => {
    const { res, next } = run(createBullBoardAuthMiddleware(false, 'a', 'b'));
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('never serves the page when enabled without credentials', () => {
    for (const [user, pass] of [
      [undefined, undefined],
      ['admin', undefined],
      [undefined, 'secret'],
      ['', ''],
    ]) {
      const { res, next } = run(
        createBullBoardAuthMiddleware(true, user, pass),
      );
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(BULL_BOARD_NO_CREDENTIALS_MESSAGE);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('asks for credentials when none are sent', () => {
    const { res, next } = run(
      createBullBoardAuthMiddleware(true, 'admin', 'secret'),
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toContain('Basic');
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses wrong credentials, including a wrong length', () => {
    const middleware = createBullBoardAuthMiddleware(true, 'admin', 'secret');
    for (const header of [
      basic('admin', 'wrong'),
      basic('admin', 'secret-but-longer'),
      basic('other', 'secret'),
      basic('admin', ''),
      'Basic not-base64-without-colon',
    ]) {
      const { res, next } = run(middleware, header);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('lets the right credentials through', () => {
    const { next } = run(
      createBullBoardAuthMiddleware(true, 'admin', 'secret'),
      basic('admin', 'secret'),
    );
    expect(next).toHaveBeenCalled();
  });
});

describe('assertBullBoardConfig', () => {
  it('stops the server starting when enabled without credentials', () => {
    expect(() => assertBullBoardConfig(true, undefined, undefined)).toThrow(
      'Bull Board is enabled but has no username/password',
    );
    expect(() => assertBullBoardConfig(true, 'admin', '')).toThrow();
  });

  it('allows a disabled board, or an enabled one with credentials', () => {
    expect(() =>
      assertBullBoardConfig(false, undefined, undefined),
    ).not.toThrow();
    expect(() => assertBullBoardConfig(true, 'admin', 'secret')).not.toThrow();
  });
});
