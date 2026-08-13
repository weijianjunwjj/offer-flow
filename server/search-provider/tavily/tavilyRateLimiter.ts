/**
 * OfferFlow v0.9 — Token Bucket rate limiter for Tavily Search Provider.
 *
 * Task: T026
 *
 * Simple token bucket algorithm for provider rate limiting.
 * Not coupled to any specific HTTP library or provider.
 */

export interface TokenBucketOptions {
  /** Maximum number of tokens in the bucket. */
  maxTokens: number;
  /** Tokens replenished per refillInterval. */
  refillRate: number;
  /** Refill interval in milliseconds. */
  refillInterval: number;
  /** Optional clock for testing. */
  now?: () => number;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.maxTokens = options.maxTokens;
    this.refillRate = options.refillRate;
    this.refillInterval = options.refillInterval;
    this.now = options.now ?? (() => Date.now());
    this.tokens = this.maxTokens;
    this.lastRefill = this.now();
  }

  /**
   * Try to consume one token. Refills the bucket based on elapsed time before checking.
   * @returns true if a token was consumed, false if bucket is empty.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Return approximate time (epoch ms) until the next token is available.
   * Returns 0 if tokens are currently available.
   */
  nextAvailableIn(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    // If still empty after refill, estimate time until next token.
    return Math.ceil(this.refillInterval / this.refillRate);
  }

  /** Current token count (for testing). */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.refillInterval) * this.refillRate);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}
