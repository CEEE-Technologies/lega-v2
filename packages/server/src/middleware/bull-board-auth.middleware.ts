import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';

export const BULL_BOARD_NO_CREDENTIALS_MESSAGE =
  'Bull Board is enabled but has no username/password. Set BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD, or set BULL_BOARD_ENABLED=false.';

/**
 * Throws when Bull Board is enabled without credentials, so a misconfigured
 * server refuses to start instead of serving the jobs page to anyone.
 */
export function assertBullBoardConfig(
  enabled: boolean,
  username: string | undefined,
  password: string | undefined,
): void {
  if (enabled && (!username || !password)) {
    throw new Error(BULL_BOARD_NO_CREDENTIALS_MESSAGE);
  }
}

/**
 * Compares two strings in constant time (hashing first, so the lengths
 * don't leak either).
 */
function safeEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Creates Express middleware for the Bull Board UI:
 * - When disabled: responds with 404.
 * - When enabled and username/password are set: enforces HTTP Basic Auth (401 if invalid).
 * - When enabled and credentials are not set: never serves the page (503).
 */
export function createBullBoardAuthMiddleware(
  enabled: boolean,
  username: string | undefined,
  password: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      res.status(404).send('Not Found');
      return;
    }

    if (!username || !password) {
      res.status(503).send(BULL_BOARD_NO_CREDENTIALS_MESSAGE);
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
      res.status(401).send('Authentication required');
      return;
    }

    const base64Credentials = authHeader.slice(6);
    let decoded: string;
    try {
      decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
    } catch {
      res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
      res.status(401).send('Invalid credentials');
      return;
    }

    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
      res.status(401).send('Invalid credentials');
      return;
    }

    const reqUsername = decoded.slice(0, colonIndex);
    const reqPassword = decoded.slice(colonIndex + 1);

    // Both are compared even when the first fails, so timing reveals nothing.
    const usernameOk = safeEqual(reqUsername, username);
    const passwordOk = safeEqual(reqPassword, password);

    if (!usernameOk || !passwordOk) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
      res.status(401).send('Invalid credentials');
      return;
    }

    next();
  };
}
