export interface TranslateService {
  id: string;
  /** Batch translate; inputs and outputs correspond by index. Input may contain <tN> pseudo tags and {{N}} placeholders. */
  translate(texts: string[], to: string, signal?: AbortSignal): Promise<string[]>;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    public retryable = false,
    /** Server-requested cooldown (Retry-After), honored by the engine's retry backoff. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient failures worth retrying: rate limit (429), server error (5xx), or network failure (0). */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500 || status === 0;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header?: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}