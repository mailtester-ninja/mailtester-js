# MailTester Ninja for JavaScript and TypeScript

Official client for the [MailTester Ninja](https://mailtester.ninja) email verification API. Check in real time whether an email address is valid and deliverable: each address is checked against the recipient's mail server, and nothing is stored. With a paid key, `find` also looks up a person's work email from their name and company domain.

- Zero dependencies, typed, ESM and CommonJS
- Node.js 18+, Deno, Bun and browsers (CORS is open)
- Free to try: no signup with `key: "free"`, or a [free API token](https://mailtester.ninja/free-email-verification-api/) for 50 checks a day

```bash
npm install @mailtester-ninja/client
```

## Quickstart

```js
import { MailTester } from '@mailtester-ninja/client';

const mt = new MailTester({ key: process.env.MAILTESTER_KEY }); // falls back to "free"

const result = await mt.verify('info@apple.com');
console.log(result.code, result.message); // "ok" "Accepted"
```

CommonJS works too: `const { MailTester } = require('@mailtester-ninja/client');`

## Reading the verdict

Branch on `code`, show `message` to people.

| `code` | Meaning | Typical `message` |
|--------|---------|-------------------|
| `ok` | Valid and deliverable | Accepted |
| `ko` | Invalid, will bounce | Rejected, No MX, Disposable, Limited |
| `mb` | Uncertain: catch-all domain, or the server could not be probed | Catch-All, MX Error, Timeout, SPAM Block, Greylisted |

A catch-all domain is never reported as valid.

`await mt.isDeliverable(email)` is a shortcut that returns `true` only for `ok`.

## Verify a list

`verifyMany` checks one address at a time and paces the calls for you: 30 seconds apart on the free tier, 1 second with a paid key (override with `delayMs`). Errors are reported per address, the loop keeps going.

```js
for await (const { email, result, error } of mt.verifyMany(['info@apple.com', 'someone@example.com'])) {
  if (error) console.log(email, 'no verdict:', error.message);
  else console.log(email, result.code, result.message);
}
```

## Find a work email (paid key)

`find` calls the Finder API: it tests the most common address formats one by one (first.last, flast, first, firstlast, first_last, f.last) and returns the first one the mail server accepts.

```js
const r = await mt.find('Jean-Pierre', 'De La Tour', 'example.com');
if (r.found) console.log(r.email);       // an address the mail server just accepted
else console.log(r.message, r.guess);    // e.g. "Catch-All" and the most common format
console.log(r.permutations);             // formats tested, each one counted as a verification
```

- Each format tested counts as one verification against your daily limit, even when nothing is found. The search paces itself within the rate of your key.
- On a catch-all domain nothing can be confirmed: `found` is `false` and `guess` holds the most common format.
- Personal email providers such as gmail.com are not searched (`message` is `Webmail`).
- A free key is refused with `MailTesterKeyError`; over the rate of your key, `MailTesterRateLimitError` carries `retryAfterSeconds`.

## Errors

An error is never a verdict: do not drop an address because of it.

| Error | When |
|-------|------|
| `MailTesterKeyError` | The key is invalid or disabled, or `find` was called with a free key. |
| `MailTesterRateLimitError` | A limit was reached (HTTP 429). `retryAfterSeconds` is set on the free tier and by `find`. |
| `MailTesterError` | Any other HTTP or network error (`status` when there is one). |

## Keys and limits

| Key | Daily checks | Pace |
|-----|--------------|------|
| `free` | 10 per IP | 1 request every 30 s |
| Free token `mtf_...` ([get one](https://mailtester.ninja/free-email-verification-api/)) | 50 per token | 1 request every 30 s |
| Paid key `sub_...` ([plans](https://mailtester.ninja/verify-emails-unlimited/)) | 100,000 to 200,000+ | daily limit / 8640 per 10 s (Pro 11, Ultimate 23) |

Options: `new MailTester({ key, baseUrl, timeoutMs, fetch })`. The key defaults to the `MAILTESTER_KEY` environment variable, then to `free`.

## Links

- [API documentation](https://mailtester.ninja/api/) and [OpenAPI 3.1 specification](https://mailtester.ninja/openapi.json)
- [Integrations](https://mailtester.ninja/integrations/): n8n, Zapier, Make, Clay, Google Sheets
- [Code examples](https://github.com/mailtester-ninja/mailtester-api-examples) for other languages
- [Python client](https://pypi.org/project/mailtester-ninja/)

## License

MIT
