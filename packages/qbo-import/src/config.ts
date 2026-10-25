import { config as dotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "./types.js";
export interface Config {
  environment: Environment;
  clientId: string;
  clientSecret: string;
  tokenKey: Buffer;
  redirectUri: string;
  stateDir: string;
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export function loadConfig(): Config {
  dotenv({ path: resolve(repoRoot, ".env") });
  return configFromEnv(process.env, repoRoot);
}
export function configFromEnv(env: NodeJS.ProcessEnv, root: string): Config {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value)
      throw new Error(`Missing ${key}; see packages/qbo-import/README.md`);
    return value;
  };
  const environment = env.QBO_ENVIRONMENT ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production")
    throw new Error("QBO_ENVIRONMENT must be sandbox or production");
  const redirectUri = env.QBO_REDIRECT_URI || "http://localhost:9477/callback";
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new Error("Invalid QBO_REDIRECT_URI");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    redirect.hostname,
  );
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !redirect.pathname ||
    (environment === "production" &&
      (redirect.protocol !== "https:" || loopback)) ||
    (environment === "sandbox" && (redirect.protocol !== "http:" || !loopback))
  )
    throw new Error(
      "QBO_REDIRECT_URI must be loopback HTTP for sandbox, or a registered non-localhost HTTPS URL for production",
    );
  const encodedKey = required("QBO_TOKEN_KEY");
  const tokenKey = Buffer.from(encodedKey, "base64");
  if (tokenKey.length !== 32 || tokenKey.toString("base64") !== encodedKey)
    throw new Error(
      "QBO_TOKEN_KEY must be a canonical base64 encoded 32-byte key",
    );
  return {
    environment,
    clientId: required("QBO_CLIENT_ID"),
    clientSecret: required("QBO_CLIENT_SECRET"),
    tokenKey,
    redirectUri,
    stateDir: resolve(root, env.QBO_STATE_DIR || ".qbo-state"),
    apiBaseUrl:
      environment === "sandbox"
        ? "https://sandbox-quickbooks.api.intuit.com"
        : "https://quickbooks.api.intuit.com",
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  };
}
