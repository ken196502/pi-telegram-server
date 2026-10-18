# Plan: Fix Telegram "there is no document in the request" (pi_telegram_setup)

## Symptom
Pi reported:
```
Error: Telegram table export failed: {"ok":false,"error":"Bad Request: there is no document in the request"}
```
This message is produced in `extensions/telegram-mirror.mjs:902` when the auto table-export
calls `sendFile(htmlFile, ...)` → POST `/webhook` → gateway `sendDocument` → Telegram Bot API.

## Root cause (confirmed empirically)
`src/gateway.mjs` builds the multipart upload with the **standalone `undici` package's
`FormData`** (`UndiciFormData`), but `proxyFetch` dispatched to **Node's global `fetch`**
when no proxy is configured:

```js
const proxyFetch = (url, opts) => proxyAgent && !isLocalUrl(url)
  ? undiciFetch(url, { ...opts, dispatcher: proxyAgent })
  : fetch(url, opts);   // <-- global fetch
```

On the running gateway (Node **v24.21.0**, undici 8.10.1) global `fetch` does **not**
recognize the undici-package `FormData`. Reproduction against a local echo server:

| fetch used | content-type received | document field present | body length |
|---|---|---|---|
| `global fetch` (Node 24) | `text/plain;charset=UTF-8` | **false** | 17 (`[object FormData]`) |
| `undici.fetch` (Node 24) | `multipart/form-data; boundary=...` | true | 277 |

So Telegram received a plain-text body with no multipart part named `document` and returned
`Bad Request: there is no document in the request`. A live test through the running gateway
failed identically for both ASCII and Chinese filenames, confirming it is not a filename issue.

(On Node 22 the same global `fetch` *did* duck-type the external FormData, which is why this
was latent until the gateway was launched with Node 24.)

## Fix
In `src/gateway.mjs`, make `proxyFetch` **always** use `undiciFetch` (the same undici package
that provides `FormData`/`ProxyAgent`), attaching the proxy dispatcher only when required:

```js
const proxyFetch = (url, opts) =>
  undiciFetch(url, proxyAgent && !isLocalUrl(url) ? { ...opts, dispatcher: proxyAgent } : opts);
```

This keeps the FormData/fetch implementations in the same package for text, JSON, documents,
polling, and inbound forwarding. Add an explanatory comment referencing the Node 24 behavior.

## Verification
1. Static: `node --check src/gateway.mjs`.
2. Local multipart test on the same Node major (v24) proving `undiciFetch` + `UndiciFormData`
   yields a multipart body with the `document` field.
3. Live: restart the gateway and POST a small file through `/webhook`; expect `{"ok":true,...}`
   (and a file arriving in the Telegram chat) instead of the policy error.
4. Existing tests: `timeout 240 npm test`.
5. Clean up temp files and ensure no stray processes.

## Operational note
The running gateway must be restarted to load the fix (it is running old code in memory).

## Result (verified)
- `gateway.mjs` now routes all requests through `undiciFetch`.
- `lib.mjs` `guessMimeType` now maps `html`/`htm` → `text/html`.
- Live tests through the restarted gateway: ASCII and CJK filenames both returned
  `{"ok":true,...}` (message ids 8692, 8693), and an end-to-end markdown-table → HTML
  export returned `{"ok":true,...,"mimetype":"text/html"}` (message id 8697).
- `node --check` passed and `npm test` passed 54/54.
- Gateway restarted detached (`npm start`, PID group 212712/212713); health `connected`.
