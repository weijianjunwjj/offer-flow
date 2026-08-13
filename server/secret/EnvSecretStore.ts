/**
 * OfferFlow v0.9 — EnvSecretStore.
 *
 * Task: T025
 *
 * Reads secrets from process.env using a fixed prefix convention.
 * Intended for dev/test use only — secrets are stored in plaintext
 * in the process environment.
 *
 * Reference format: "env:TAVILY_API_KEY"
 * The actual env var name follows the colon.
 */

import type { SecretStore } from './SecretStore';

const PREFIX = 'env:';

export class EnvSecretStore implements SecretStore {
  resolve(ref: string): string {
    if (!ref.startsWith(PREFIX)) {
      throw new Error(`EnvSecretStore: invalid secret ref "${ref}"`);
    }
    const varName = ref.slice(PREFIX.length);
    const value = process.env[varName];
    if (value === undefined || value === '') {
      throw new Error(
        `EnvSecretStore: environment variable "${varName}" is not set or empty`,
      );
    }
    return value;
  }

  store(key: string, secret: string): string {
    if (key.includes(' ')) {
      throw new Error(`EnvSecretStore: secret key must not contain spaces: "${key}"`);
    }
    const ref = `${PREFIX}${key}`;
    process.env[key] = secret;
    return ref;
  }

  delete(ref: string): void {
    if (!ref.startsWith(PREFIX)) {
      throw new Error(`EnvSecretStore: invalid secret ref "${ref}"`);
    }
    const varName = ref.slice(PREFIX.length);
    delete process.env[varName];
  }
}
