import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthApiKeyPrefix, AuthApiKeyPrefixLength } from './Auth.constants';

export const hashPassword = (password: string): Promise<string> =>
  new Promise((resolve) => {
    bcrypt.genSalt(10, (error, salt) => {
      bcrypt.hash(password, salt, (err, hash: string) => {
        resolve(hash);
      });
    });
  });

/**
 * Extracts and validates an API key from the Authorization header
 * @param {string} authorization - Full authorization header content.
 */
export const getAuthApiKey = (authorization: string) => {
  const apiKey = authorization.toLowerCase().replace('bearer ', '').trim();
  return apiKey.startsWith(AuthApiKeyPrefix) ? apiKey : '';
};

/**
 * Hashes the API key using SHA-256 to avoid storing the plain key in database.
 * @param {string} apiKey - The plain API key.
 * @returns {string} Hex encoded SHA-256 hash of the key.
 */
export const hashApiKey = (apiKey: string): string => {
  return createHash('sha256').update(apiKey).digest('hex');
};

/**
 * Extracts the displayable prefix of the API key.
 * @param {string} apiKey - The plain API key.
 * @returns {string} The displayable prefix of the API key.
 */
export const getApiKeyPrefix = (apiKey: string): string => {
  return apiKey.substring(0, AuthApiKeyPrefixLength);
};

/**
 * Hashes a password reset token with SHA-256. Only the hash is stored, so
 * someone who reads the database can't use a pending reset link.
 * @param {string} token - The raw token sent in the reset link.
 * @returns {string} Hex encoded SHA-256 hash of the token.
 */
export const hashPasswordResetToken = (token: string): string => {
  return createHash('sha256').update(String(token)).digest('hex');
};
