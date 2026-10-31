/**
 * Official JavaScript and TypeScript client for the MailTester Ninja email verification API.
 * https://mailtester.ninja/api/
 */

export const VERSION = '1.1.0';
export const DEFAULT_BASE_URL = 'https://happy.mailtester.ninja';
/** Keyless free tier: 10 checks a day per IP, one request every 30 seconds. */
export const FREE_KEY = 'free';

/** `ok` valid and deliverable, `ko` invalid, `mb` uncertain (catch-all or not probeable). */
export type Verdict = 'ok' | 'ko' | 'mb';

export interface VerificationResult {
  /** Machine-readable verdict. */
  code: Verdict;
  /** Human-readable label: Accepted, Rejected, Catch-All, No MX, Disposable, Timeout... */
  message: string;
  /** The address that was checked. */
  email: string;
  /** A human-readable guess of the name, derived from the address. */
  user?: string;
  domain?: string | null;
  /** Mail server used for the check. */
  mx?: string;
  /** Simultaneous connections used by the key. */
  connections?: number;
  /** Daily limit of the key. */
  limit?: number;
  /** Requests made with the key over the last 10 seconds. */
  rate?: number;
}

/** Result of a Finder API search (`find`). Check `found` first. */
export interface FindResult {
  /** `ok` found, `ko` not found, `mb` uncertain (catch-all domain, personal email provider, server not checked). */
  code: Verdict;
  /** Accepted, Rejected, Catch-All, Limited, No MX, Disposable, SPAM Block, Timeout, Webmail... */
  message: string;
  /** True when the mail server accepted one of the formats. */
  found: boolean;
  /** The address found, otherwise null. */
  email: string | null;
  /** Not verified: on a catch-all domain the most common format, for a full mailbox (Limited) that address. */
  guess: string | null;
  first: string;
  last: string;
  /** The normalised domain that was searched. */
  domain: string;
  /** Mail server used for the search. */
  mx: string;
  /** Address formats tested, each one counted as a verification, even when nothing is found. */
  permutations: number;
  /** Simultaneous connections used by the key. */
  connections?: number;
  /** Daily limit of the key. */
  limit?: number;
  /** Verifications made with the key over the last 10 seconds, permutations included. */
  rate?: number;
  /** Seconds taken by the search. */
  duration?: number;
  /** Why nothing was found, in plain English. Null when found. */
  reason: string | null;
}

export interface MailTesterOptions {
  /**
   * `free` (no signup), a free token `mtf_...` from https://mailtester.ninja/free-email-verification-api/,
   * or a subscription key `sub_...`. Defaults to the MAILTESTER_KEY environment variable, then `free`.
   */
  key?: string;
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Custom fetch implementation (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface VerifyManyOptions {
  /** Pause between calls in milliseconds. Default: 30000 on the free tier, 1000 with a paid key. */
  delayMs?: number;
  /** On a free tier limit (HTTP 429), wait the announced time and retry once. Default true. */
  retryOnLimit?: boolean;
}

export interface VerifyManyItem {
  email: string;
  result?: VerificationResult;
  error?: MailTesterError;
}

/** Any error returned by the API or the network. Never a verdict: do not drop the address on it. */
export class MailTesterError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MailTesterError';
    this.status = status;
  }
}

/** The key is invalid or disabled (`code` "--"). */
export class MailTesterKeyError extends MailTesterError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'MailTesterKeyError';
  }
}

/** A limit was reached (HTTP 429). `retryAfterSeconds` is set when the API says how long to wait. */
export class MailTesterRateLimitError extends MailTesterError {
  readonly retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message, 429);
    this.name = 'MailTesterRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function envKey(): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.MAILTESTER_KEY || undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function retryAfter(message: string): number | undefined {
  const m = /retry in (\d+)\s*s/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

export class MailTester {
  readonly key: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MailTesterOptions | string = {}) {
    const opts: MailTesterOptions = typeof options === 'string' ? { key: options } : options;
    this.key = (opts.key ?? envKey() ?? FREE_KEY).trim().replace(/^\{|\}$/g, '');
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60000;
    const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new MailTesterError('No fetch implementation available: use Node.js 18 or later, or pass options.fetch');
    this.fetchImpl = f;
  }

  /** True on the free tier (`free` or a free token), limited to one request every 30 seconds. */
  get isFree(): boolean {
    return this.key === FREE_KEY || this.key.startsWith('mtf_');
  }

  private async request(url: string): Promise<{ res: Response; text: string; body?: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      throw new MailTesterError(aborted ? `Request timed out after ${this.timeoutMs} ms` : `Network error: ${String((err as Error)?.message ?? err)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    return { res, text, body: parseJson(text) };
  }

  /** Verify one address. Resolves to a verdict, rejects with a MailTesterError when there is none. */
  async verify(email: string): Promise<VerificationResult> {
    const { res, text, body } = await this.request(`${this.baseUrl}/ninja?email=${encodeURIComponent(email.trim())}&key=${encodeURIComponent(this.key)}`);
    const message = typeof body?.message === 'string' ? body.message : text.trim();
    if (res.status === 429) throw new MailTesterRateLimitError(message, retryAfter(message));
    if (!res.ok) throw new MailTesterError(message || `HTTP ${res.status}`, res.status);
    if (!body) throw new MailTesterError('Unexpected response from the API', res.status);
    if (body.code === '--') throw new MailTesterKeyError(message, res.status);
    return body as unknown as VerificationResult;
  }

  /**
   * Find a work email address from a first name, a last name and a company domain (Finder API, paid key).
   * The API tests the most common formats one by one (first.last, flast, first, firstlast, first_last, f.last)
   * and returns the first address the mail server accepts. Each format tested counts as one verification.
   * Resolves to a FindResult (check `found`), rejects with a MailTesterError when the search did not run.
   */
  async find(first: string, last: string, domain: string): Promise<FindResult> {
    if (this.isFree) {
      throw new MailTesterKeyError('The Finder API needs a paid key: https://mailtester.ninja/verify-emails-unlimited/', 403);
    }
    const qs = new URLSearchParams({ first: first.trim(), last: last.trim(), domain: domain.trim(), key: this.key });
    const { res, text, body } = await this.request(`${this.baseUrl}/find?${qs}`);
    const reason = typeof body?.reason === 'string' && body.reason ? body.reason : undefined;
    const message = reason ?? (typeof body?.message === 'string' ? body.message : text.trim());
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      throw new MailTesterRateLimitError(message, Number.isFinite(wait) && wait > 0 ? wait : undefined);
    }
    if (res.status === 403 && body) throw new MailTesterKeyError(message, 403);
    if (!res.ok) throw new MailTesterError(message || `HTTP ${res.status}`, res.status);
    if (!body) throw new MailTesterError('Unexpected response from the API', res.status);
    if (body.code === '--') throw new MailTesterKeyError(message, res.status);
    return body as unknown as FindResult;
  }

  /** True only when the address is clearly valid and deliverable (`code` "ok"). */
  async isDeliverable(email: string): Promise<boolean> {
    return (await this.verify(email)).code === 'ok';
  }

  /**
   * Verify a list, one address at a time, pacing the calls to respect the rate limit.
   * Yields `{ email, result }` or `{ email, error }` for each non-empty address.
   */
  async *verifyMany(emails: Iterable<string> | AsyncIterable<string>, options: VerifyManyOptions = {}): AsyncGenerator<VerifyManyItem> {
    const delayMs = options.delayMs ?? (this.isFree ? 30000 : 1000);
    const retryOnLimit = options.retryOnLimit ?? true;
    let first = true;
    for await (const raw of emails) {
      const email = String(raw).trim();
      if (!email) continue;
      if (!first && delayMs > 0) await sleep(delayMs);
      first = false;
      try {
        yield { email, result: await this.verify(email) };
      } catch (err) {
        if (retryOnLimit && err instanceof MailTesterRateLimitError && err.retryAfterSeconds !== undefined) {
          await sleep((err.retryAfterSeconds + 1) * 1000);
          try {
            yield { email, result: await this.verify(email) };
          } catch (err2) {
            yield { email, error: err2 instanceof MailTesterError ? err2 : new MailTesterError(String(err2)) };
          }
        } else {
          yield { email, error: err instanceof MailTesterError ? err : new MailTesterError(String(err)) };
        }
      }
    }
  }
}

export default MailTester;
