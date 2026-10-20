export function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts && (status === 429 || status >= 500);
}

// attempt starts at 1 for the first request.
