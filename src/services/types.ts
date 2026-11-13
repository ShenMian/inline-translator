export interface TranslateService {
  id: string;
  /** Batch translate; inputs and outputs correspond by index. Input may contain <tN> pseudo tags and {{N}} placeholders. */
  translate(texts: string[], to: string): Promise<string[]>;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient failures worth retrying: rate limit (429), server error (5xx), or network failure (0). */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500 || status === 0;
}