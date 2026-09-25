# Inbox Signal implementation plan

## Goal and first release

Help the person reading Gmail assess the **currently open, expanded email** for signs of phishing or unusual requests. The first release is an on-demand check from the Chrome toolbar. The popup shows a risk band, the specific signals that contributed to it, and a short suggestion such as verifying the sender through a known channel. The extension must never silently quarantine, delete, or click anything in Gmail.

The current implementation captures a message on demand, shows a preview, and sends it to Jev only after a second explicit click. An inbox-wide scan would require a separate product decision and likely Gmail API/OAuth work; the current `activeTab` permission supports only the user-invoked tab.

## Architecture

```text
Gmail page (open message)
  → on-demand isolated script: subject, sender, visible body, links
  → extension popup: preview and request consent
  → local analysis endpoint: validate, minimize, and rate-limit
  → TypeSafe Jev: independent typed judgments
  → endpoint: combine judgments with deterministic link checks
  → popup: risk band and evidence labels
```

The Jev API token is a server secret named `TYPESAFE_API_KEY`. Do not put it in the extension source, manifest, browser storage, or an `extension/` asset. Chrome extensions are distributed to users, so a bundled token cannot remain secret. The current relay is a development service: it binds only to loopback and checks the configured extension origin. That origin check is not full authentication. A deployed endpoint needs user authentication, request size limits, rate limiting, and a narrowly configured extension origin. Never treat a CORS allowlist alone as authentication.

When the endpoint exists, add its exact origin to the extension's `host_permissions`; the current manifest has no network host permission. The endpoint address itself is configuration, not a secret.

The browser extension has no build dependencies. The `server/` package uses the official `@typesafe-ai/sdk` JavaScript SDK, which requires Node.js 20+ and reads `TYPESAFE_API_KEY` from the environment. The local runner uses Node's built-in `.env` loading and therefore needs Node.js 20.6+. It currently calls `model: "jev-latest"`; before release, evaluate the chosen version and pin a model version so model updates do not silently change calibrated behavior. The raw API alternative is `POST https://api.typesafe.ai/v1/systemone` with a bearer token.

## Data contract

Capture only what Jev needs for a useful judgment:

```json
{
  "subject": "Action required for your account",
  "sender": { "name": "Example Support", "email": "support@example.test" },
  "body": "Please verify your account ...",
  "bodyTruncated": false,
  "links": [{ "text": "Verify account", "href": "https://example.test/verify" }],
  "linksTruncated": false
}
```

The DOM capture bounds body text to 30,000 characters and links to 50 entries. The relay validates field types and lengths, removes URL paths, query strings, and fragments before sending link destinations to Jev, and rejects malformed messages. It does not log message bodies or URLs. The captured email and result live in popup memory; closing the popup discards them. If caching is later useful, define a short retention period and a clear user control first.

The endpoint contract is `POST /analyze` with `{ "message": <the captured message> }`. It returns an application-owned response, for example:

```json
{
  "band": "review",
  "score": 1.72,
  "confidence": 0.68,
  "signals": [
    { "id": "coercive_pressure", "label": "The message uses unusual pressure, secrecy, or instructions to bypass verification.", "probability": 0.61 }
  ],
  "coverage": "complete"
}
```

The first `low`, `review`, and `high` thresholds are provisional and exist to make the end-to-end flow testable; calibrate them against labeled safe, suspicious, and ambiguous emails before release. Return an error state for unavailable analysis; a network failure must never look like a low-risk verdict. The endpoint does not expose the Jev token or raw provider error details to the popup.

Gmail's DOM is not a stable public API. The selectors in `extension/content/extract-message.js` are an initial heuristic for the last expanded message in a conversation. Validate them against real Gmail layouts, multiple expanded messages, collapsed messages, dark mode, and account variants. If DOM extraction proves unreliable or full headers are needed, investigate the Gmail API and its OAuth and scope implications before replacing the capture layer.

## Jev question design

Send the message as structured `state` with named fields (`subject`, `sender`, `body`, `links`) and batch independent questions in one System One request. Start with narrow Noul judgments such as:

- Does the message request a password, one-time code, payment detail, or account recovery action?
- Does the sender identity or a linked destination conflict with the organization the message claims to represent?
- Does the wording pressure the reader to act urgently, keep the request secret, or bypass normal verification?
- Does a link's visible text imply a different destination from its actual URL?

The current implementation asks four narrow Nouls and one Score question in a single Jev call. Jev returns probabilities and typed answers; it does **not** generate an explanation. Code composes a risk band and displays fixed labels for questions or deterministic checks that fired. A Noul value near 0.5 is uncertainty between yes and no, not a medium-strength warning. The current thresholds are provisional, not validated detection rates. Evaluate against labeled safe, suspicious, and ambiguous emails, including legitimate urgent mail and legitimate third-party links.

Deterministic checks belong in code: URL parsing, hostname comparison, known URL schemes, and whether a visible URL disagrees with its href. Treat different sender and link domains as a signal to review, not proof of phishing; legitimate services often use distinct domains. If message text is truncated, tell Jev and surface limited coverage to the user.

## Build sequence

1. **Validate capture.** Test Gmail DOM extraction against varied real messages, threads, collapsed messages, and account layouts. Adjust selectors when needed.
2. **Harden the service for deployment.** Add actual user authentication, deployment-specific endpoint configuration, secrets management, and operational monitoring before exposing the relay beyond local development.
3. **Calibrate the model.** Build a labeled test set and evaluate false positives and false negatives. Confirm that the deployed Jev model version and all risk thresholds are fixed and documented.
4. **Verify integration.** Exercise missing tokens, invalid requests, TypeSafe 401/422/429/529 responses, network timeouts, truncated messages, link edge cases, and service shutdown. Keep provider failures distinct from low-risk results.

## Current status

Implemented: loadable Manifest V3 popup, temporary tab permission, on-demand Gmail DOM capture, local relay with origin checks and request limits, server-side Jev request, provisional risk composition, and explicit scan UI.

Pending: live Gmail selector validation, labeled-email evaluation, final thresholds, and production authentication/deployment.

## Local test steps

1. Load `extension/` unpacked in Chrome and copy the extension ID.
2. Create `server/.env` from `.env.example`. Set `TYPESAFE_API_KEY` and `EXTENSION_ID`.
3. From `server/`, run `npm install`, then `npm run typecheck`, then `npm run dev`.
4. Confirm `http://127.0.0.1:8787/health` returns `{"status":"ok"}`.
5. Reload the extension, open an email in Gmail, capture it, check the displayed sender/subject, then click **Analyze with Jev**. Confirm a band and signal list appear.
6. Try a non-Gmail tab, a Gmail inbox without an opened message, and a long email with links. These should produce clear errors or a limited-coverage result, never a low-risk result on failure.

The analyze action sends captured text and link text/hostnames to TypeSafe and consumes Jev API usage. Test with messages you are comfortable sending for analysis.

## References

- [Chrome extension quick start](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome `activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe state guidance](https://docs.typesafe.ai/concepts/state)
- [TypeSafe Noul guidance](https://docs.typesafe.ai/primitives/noul)
