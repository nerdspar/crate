/**
 * Network helpers shared by the server + providers.
 */

/**
 * `fetch()` with an AbortController timeout so a wedged or half-open connection
 * rejects instead of hanging forever. `timeoutMs` defaults to 15s. Any caller
 * signal is replaced by the timeout's.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}
