/**
 * OfferFlow v0.9 — SecretStore abstract interface.
 *
 * Task: T025
 * Plan: specs/001-daily-job-hunter/plan.md v3.0 §2.20（Secret management）
 *
 * SecretStore abstracts credential storage. Implementations:
 *  - EnvSecretStore — reads from process.env (dev/test).
 *  - MemorySecretStore — in-memory Map (test only).
 *  - WindowsDpapiSecretStore — DPAPI encrypted storage (future, not in T025).
 */

export interface SecretStore {
  /**
   * Resolve a secret reference to its plaintext value.
   * @param ref — opaque reference returned by store().
   * @returns plaintext secret.
   * @throws if ref is unknown or the backing store is unavailable.
   */
  resolve(ref: string): string | Promise<string>;

  /**
   * Store a secret and return an opaque reference for later resolution.
   * @param key — logical key (e.g. 'TAVILY_API_KEY').
   * @param secret — plaintext secret value.
   * @returns opaque reference string to pass to resolve().
   */
  store(key: string, secret: string): string | Promise<string>;

  /**
   * Delete a stored secret by its reference.
   * @param ref — opaque reference returned by store().
   * @throws if ref is unknown.
   */
  delete(ref: string): void | Promise<void>;
}
