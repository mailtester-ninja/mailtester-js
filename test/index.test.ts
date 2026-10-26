import { describe, expect, it } from 'vitest';
import { MailTester, MailTesterError, MailTesterKeyError, MailTesterRateLimitError } from '../src/index';

type Reply = { status: number; body: string };

function fakeFetch(replies: Reply[], calls: { url: string; init?: RequestInit }[] = []) {
  let i = 0;
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  return f as unknown as typeof fetch;
}

const ok = { code: 'ok', message: 'Accepted', domain: 'apple.com', mx: 'mx-in.g.apple.com', connections: 1, limit: 100000, rate: 1, email: 'info@apple.com', user: 'Info' };

describe('MailTester.verify', () => {
  it('returns the verdict and sends email, key and Accept header', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const mt = new MailTester({ key: 'sub_123', fetch: fakeFetch([{ status: 200, body: JSON.stringify(ok) }], calls) });
    const r = await mt.verify('info@apple.com');
    expect(r.code).toBe('ok');
    expect(r.message).toBe('Accepted');
    expect(calls[0].url).toBe('https://happy.mailtester.ninja/ninja?email=info%40apple.com&key=sub_123');
    expect((calls[0].init?.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('strips braces around a pasted key and defaults to the free tier', () => {
    expect(new MailTester({ key: '{sub_abc}', fetch: fakeFetch([]) }).key).toBe('sub_abc');
    const free = new MailTester({ fetch: fakeFetch([]) });
    expect(['free', process.env.MAILTESTER_KEY]).toContain(free.key);
    expect(new MailTester({ key: 'mtf_x', fetch: fakeFetch([]) }).isFree).toBe(true);
    expect(new MailTester({ key: 'sub_x', fetch: fakeFetch([]) }).isFree).toBe(false);
  });

  it('accepts the key as a string', () => {
    expect(new MailTester('sub_xyz').key).toBe('sub_xyz');
  });

  it('throws MailTesterKeyError on an invalid key', async () => {
    const body = JSON.stringify({ ...ok, code: '--', message: 'Invalid Key', domain: null, limit: 0 });
    const mt = new MailTester({ key: 'bad', fetch: fakeFetch([{ status: 200, body }]) });
    await expect(mt.verify('info@apple.com')).rejects.toBeInstanceOf(MailTesterKeyError);
  });

  it('throws MailTesterRateLimitError with the retry delay on a free tier 429', async () => {
    const body = JSON.stringify({ ...ok, code: '--', message: 'Free API: one request every 30 s, retry in 29 s. Unlimited speed: https://mailtester.ninja/verify-emails-unlimited/' });
    const mt = new MailTester({ key: 'free', fetch: fakeFetch([{ status: 429, body }]) });
    const err = await mt.verify('info@apple.com').catch((e) => e);
    expect(err).toBeInstanceOf(MailTesterRateLimitError);
    expect(err.retryAfterSeconds).toBe(29);
    expect(err.status).toBe(429);
  });

  it('throws MailTesterRateLimitError on a paid plain text 429', async () => {
    const mt = new MailTester({ key: 'sub_1', fetch: fakeFetch([{ status: 429, body: 'Too Many Requests - Your rate is now 25' }]) });
    const err = await mt.verify('a@b.com').catch((e) => e);
    expect(err).toBeInstanceOf(MailTesterRateLimitError);
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.message).toContain('Too Many Requests');
  });

  it('throws MailTesterError on other HTTP errors', async () => {
    const mt = new MailTester({ key: 'sub_1', fetch: fakeFetch([{ status: 403, body: 'Missing email param' }]) });
    const err = await mt.verify('').catch((e) => e);
    expect(err).toBeInstanceOf(MailTesterError);
    expect(err.status).toBe(403);
    expect(err.message).toBe('Missing email param');
  });

  it('throws MailTesterError on a network failure', async () => {
    const failing = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const mt = new MailTester({ key: 'sub_1', fetch: failing });
    await expect(mt.verify('a@b.com')).rejects.toThrow(/Network error/);
  });

  it('isDeliverable is true only for ok', async () => {
    const ko = JSON.stringify({ ...ok, code: 'ko', message: 'Rejected' });
    expect(await new MailTester({ key: 'sub_1', fetch: fakeFetch([{ status: 200, body: JSON.stringify(ok) }]) }).isDeliverable('a@b.com')).toBe(true);
    expect(await new MailTester({ key: 'sub_1', fetch: fakeFetch([{ status: 200, body: ko }]) }).isDeliverable('a@b.com')).toBe(false);
  });
});

describe('MailTester.verifyMany', () => {
  it('verifies each non-empty address and reports errors without stopping', async () => {
    const replies = [
      { status: 200, body: JSON.stringify(ok) },
      { status: 403, body: 'Missing email param' },
      { status: 200, body: JSON.stringify({ ...ok, code: 'mb', message: 'Catch-All', email: 'c@d.com' }) },
    ];
    const mt = new MailTester({ key: 'sub_1', fetch: fakeFetch(replies) });
    const out = [];
    for await (const item of mt.verifyMany(['info@apple.com', '  ', 'x@y.com', 'c@d.com'], { delayMs: 0 })) out.push(item);
    expect(out.map((i) => i.email)).toEqual(['info@apple.com', 'x@y.com', 'c@d.com']);
    expect(out[0].result?.code).toBe('ok');
    expect(out[1].error).toBeInstanceOf(MailTesterError);
    expect(out[2].result?.message).toBe('Catch-All');
  });

  it('waits and retries once after a free tier limit', async () => {
    const limited = JSON.stringify({ ...ok, code: '--', message: 'Free API: one request every 30 s, retry in 0 s.' });
    const mt = new MailTester({ key: 'free', fetch: fakeFetch([{ status: 429, body: limited }, { status: 200, body: JSON.stringify(ok) }]) });
    const out = [];
    for await (const item of mt.verifyMany(['info@apple.com'], { delayMs: 0 })) out.push(item);
    expect(out).toHaveLength(1);
    expect(out[0].result?.code).toBe('ok');
  });
});

describe.runIf(process.env.MAILTESTER_LIVE === '1')('live API (free tier)', () => {
  it('verifies a real address', async () => {
    const r = await new MailTester({ key: process.env.MAILTESTER_KEY || 'free' }).verify('info@apple.com');
    expect(['ok', 'ko', 'mb']).toContain(r.code);
  }, 90000);
});
