# Inbox Signal implementation plan

## Goal and first release

Help the person reading Gmail assess the **currently open, expanded email** for signs of phishing or unusual requests. The first release is an on-demand check from the Chrome toolbar. The popup shows a risk band, the specific signals that contributed to it, and a short suggestion such as verifying the sender through a known channel. The extension must never silently quarantine, delete, or click anything in Gmail.

The current scaffold implements only message capture and a local preview. It does not perform risk analysis. An inbox-wide scan would require a separate product decision and likely Gmail API/OAuth work; the current `activeTab` permission supports only the user-invoked tab.

## Architecture

```text
Gmail page (open message)
  → on-demand isolated script: subject, sender, visible body, links
  → extension popup: preview and request consent
  → authenticated analysis endpoint: validate, minimize, and rate-limit
  → TypeSafe Jev: independent typed judgments
  → endpoint: combine judgments with deterministic link checks
  → popup: risk band and evidence labels
```

The Jev API token is a server secret named `TYPESAFE_API_KEY`. Do not put it in the extension source, manifest, browser storage, or an `extension/` asset. Chrome extensions are distributed to users, so a bundled token cannot remain secret. A local relay can serve development; a deployed endpoint needs authentication, request size limits, rate limiting, and a narrowly configured extension origin. Never treat a CORS allowlist alone as authentication.

When the endpoint exists, add its exact origin to the extension's `host_permissions`; the current manifest has no network host permission. The endpoint address itself is configuration, not a secret.

The source tree is deliberately dependency free for the browser part. Add a separate `server/` package when implementing the endpoint. The official JavaScript SDK requires Node.js 20+ and reads `TYPESAFE_API_KEY` from the environment. The raw API alternative is `POST https://api.typesafe.ai/v1/systemone` with a bearer token and `model: "jev-latest"`.

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

The current DOM capture bounds body text to 30,000 characters and links to 50 entries. Before sending, the endpoint should validate field types and lengths, remove unneeded URL query parameters if they may contain personal tokens, and reject empty or malformed messages. Do not log message bodies or full URLs. Keep the analysis result only in popup memory initially. If caching is later useful, define a short retention period and a clear user control first.

The internal endpoint contract should be `POST /analyze` with `{ "message": <the captured message> }`. Return an application-owned response such as `{ "band": "review", "signals": ["Sender and link destination differ"], "coverage": "complete" }`. Define `low`, `review`, and `high` bands only after evaluation. Return a distinct error state for unavailable analysis; a network failure must never look like a low-risk verdict. The endpoint should not expose the Jev token or raw provider error details to the popup.

Gmail's DOM is not a stable public API. The selectors in `extension/content/extract-message.js` are an initial heuristic for the last expanded message in a conversation. Validate them against real Gmail layouts, multiple expanded messages, collapsed messages, dark mode, and account variants. If DOM extraction proves unreliable or full headers are needed, investigate the Gmail API and its OAuth and scope implications before replacing the capture layer.

## Jev question design

Send the message as structured `state` with named fields (`subject`, `sender`, `body`, `links`) and batch independent questions in one System One request. Start with narrow Noul judgments such as:

- Does the message request a password, one-time code, payment detail, or account recovery action?
- Does the sender identity or a linked destination conflict with the organization the message claims to represent?
- Does the wording pressure the reader to act urgently, keep the request secret, or bypass normal verification?
- Does a link's visible text imply a different destination from its actual URL?

Use a Score question with explicit ordered descriptions if a graded overall concern level proves useful. Jev returns probabilities and typed answers; it does **not** generate an explanation. Compose a risk band in ordinary code and display fixed, evidence-linked labels for the questions or deterministic checks that fired. A Noul value near 0.5 is uncertainty between yes and no, not a medium-strength warning. Do not set final thresholds by intuition: evaluate against labeled safe, suspicious, and ambiguous emails first, including legitimate urgent mail and legitimate third-party links.

Deterministic checks belong in code: URL parsing, hostname comparison, known URL schemes, and whether a visible URL disagrees with its href. Treat different sender and link domains as a signal to review, not proof of phishing; legitimate services often use distinct domains. If message text is truncated, tell Jev and surface limited coverage to the user.

## Build sequence

1. **Validate capture.** Test the extension manually on a range of real Gmail messages. Add fixtures and extraction tests for failures found. Make the popup show which message will be analyzed and allow the user to start the scan explicitly.
2. **Build the endpoint.** Add a Node.js 20+ service with `POST /analyze`, payload validation, authentication, bounded request size, timeouts, and safe handling of TypeSafe errors and rate limits. Load `TYPESAFE_API_KEY` from the server environment. Keep extension endpoint configuration outside the distributed secret path.
3. **Connect Jev.** Use `@typesafe-ai/sdk` or the documented HTTP API with `jev-latest`, structured state, and several independent questions in one request. Validate the returned answer types and preserve the raw probabilities for testing.
4. **Compose and display.** Apply deterministic URL checks, calibrated thresholds, and a review state for uncertain or incomplete evidence. Show the risk band and concise warning labels in the popup. Keep the language advisory rather than claiming an email is definitively safe.
5. **Verify integration.** Test Gmail DOM changes, thread selection, non-Gmail tabs, popup closure during a scan, missing token, 401/422/429/529 responses, network timeouts, long messages, and link edge cases. Run labeled-email evaluation before choosing any user-facing thresholds.

## Current status

Implemented: loadable Manifest V3 popup, temporary tab permission, on-demand Gmail DOM capture, bounded message fields, local preview, and clear capture errors.

Pending: server endpoint, Jev request, risk composition, evaluation data, and end-to-end scan UI.

## References

- [Chrome extension quick start](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome `activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe state guidance](https://docs.typesafe.ai/concepts/state)
- [TypeSafe Noul guidance](https://docs.typesafe.ai/primitives/noul)
