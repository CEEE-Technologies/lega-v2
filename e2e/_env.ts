/**
 * Server and webapp addresses for the browser tests.
 *
 * The API address follows SERVER_PORT from the root `.env` (the same setting
 * the server and the webapp dev server read), falling back to PORT and 3000.
 * PLAYWRIGHT_TEST_API_URL / PLAYWRIGHT_TEST_BASE_URL still override them.
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const serverPort = process.env.SERVER_PORT || process.env.PORT || '3000';

export const API_BASE =
  process.env.PLAYWRIGHT_TEST_API_URL || `http://localhost:${serverPort}`;

export const WEBAPP_BASE =
  process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:4000';
