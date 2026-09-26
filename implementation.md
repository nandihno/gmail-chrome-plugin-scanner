# Inbox Signal implementation

## Goal and first release

Inbox Signal is an on-demand Chrome extension for reviewing Gmail email. It has two flows:

1. Capture the currently open, expanded message in Gmail and review it individually.
2. Scan up to the 20 newest messages labeled `INBOX`, then show category, recipient-header, attention, and phishing-risk summaries.

Scanning is report-only: a scan never sends, archives, labels, deletes, marks read, or otherwise changes email. After reviewing the report, the user may explicitly select analyzed messages and apply suggested Gmail labels. The batch flow reads message bodies, but does not fetch or analyze attachments.

## Architecture and data flow

```text
Single-message flow
Gmail DOM → user-invoked content script → popup preview/consent → local relay → Jev → risk + triage result

Batch flow
User click → Chrome Identity OAuth → Gmail API (profile, latest 20 Inbox IDs, then full messages)
           → local To/Cc comparison + text/MIME parsing → batch request to local relay
           → bounded Jev calls → report page (percentages, categories, recipient relationship, evidence)

Optional label action
User selects analyzed rows → explicit Apply click → Chrome Identity OAuth → Gmail labels.list/create
                          → Gmail messages.batchModify (addLabelIds only) → per-row outcome
```

The extension uses Gmail API `messages.list` with `labelIds=INBOX` and `maxResults=20`; the API returns message IDs in newest-first order, and each message needs a separate `messages.get` request for full details. The Chrome Identity API provides the OAuth access token directly to the extension; it is never sent to the local relay or Jev. The manifest requests `gmail.readonly` for scanning. Only after the user clicks **Apply selected labels** does Chrome Identity request `gmail.modify` as an additional scope. That scope permits broader Gmail actions (including composing/sending) than the extension implements; the read-only token is used for profile/list/get, while the modify token is used only for label list/create and add-only batch modification.

The list call is read-only. The scanner requests only the first page of at most 20 messages, fetches message details with a small concurrency limit, extracts the first readable plain-text part (or HTML text as a fallback), and ignores MIME parts marked as attachments. Body text is capped at 8,000 characters per message; at most 12 links are sent to the relay.

The extension compares `To` and `Cc` addresses with the authenticated Gmail profile address plus optional user-entered aliases. That comparison happens in the browser. Alias addresses are stored in `chrome.storage.local` and are not sent to the relay or Jev. The server receives only one of these relationship labels: `to_me`, `cc_me`, `not_listed`, or `unclear`. Not listed in To/Cc is not proof of a misdelivery: Bcc, forwarding, mailing lists, and unregistered aliases can explain it.

```text
Gmail API ──OAuth token──> extension only
Gmail content ───────────> extension memory ──> 127.0.0.1 relay ──> Jev
Recipient addresses ─────> local comparison only; not included in the Jev payload
Aliases ─────────────────> chrome.storage.local only
```

The local Node relay binds to `127.0.0.1`, checks the exact configured extension origin, validates payloads, strips URL paths/query strings/fragments before Jev sees link destinations, and does not log email contents. CORS origin checks are not full authentication; this service must not be exposed beyond the local development machine without real authentication and deployment hardening.

## Permissions and OAuth setup

The extension requires `identity` and `storage`, Gmail API and local-relay host permissions, and the manifest scope `https://www.googleapis.com/auth/gmail.readonly`. `activeTab` and `scripting` remain for the individual-message flow. Chrome 105 or newer is required for the promise-based Identity API used here. On explicit label application, the scanner uses Chrome Identity's per-call scopes override to request `https://www.googleapis.com/auth/gmail.modify`; the Google consent screen must list both scopes. This delays the broader grant until the user asks to write labels.

The manifest contains the configured Chrome Extension OAuth client ID. In Google Auth Platform → Data Access, the project must include both `gmail.readonly` and `gmail.modify`; keep the app in Testing and the scanning account among test users for personal development. Scanning continues to use its existing read-only authorization. Chrome requests `gmail.modify` only if the user explicitly applies labels. Google may show an unverified-app warning while the OAuth app is in testing. These Gmail scopes are restricted; public distribution requires Google's restricted-scope verification, and transmitting restricted Gmail data to Jev through a server can trigger a security assessment. Treat this implementation as local, personal development until those requirements are addressed.

The Jev key remains a server secret in `server/.env` as `TYPESAFE_API_KEY`; never put it in the extension, manifest, or browser storage. The existing local relay is for personal development, not a multi-user production service.

## Optional label suggestions and Gmail writes

Label suggestions are derived in the extension from already returned Jev judgments plus its local To/Cc comparison; Gmail message IDs are not sent to the Jev relay. Purpose labels are suggested only when `purposeConfidence >= 0.50`. Separate labels are suggested for Jev's likely-attention result, locally observed absence of an owned address in To/Cc, and `review`/`high` risk bands. The user-facing risk label is **Risk Review**, not “phishing”; the recipient label is **Not Listed in To-Cc**, not a claim that the message was misdelivered.

All message-selection checkboxes begin unchecked. An analyzed message is eligible only after the user selects it. The selection and labels are not persisted. Scanning alone does not create labels or alter messages.

On explicit **Apply selected labels**, the extension calls Gmail `users.labels.list`, creates any missing `Inbox Signal - …` user labels, and groups selected message IDs by their exact set of suggested labels. It then calls `users.messages.batchModify` with `ids` and `addLabelIds` only. It never sends email content to Gmail again for this step, never supplies `removeLabelIds`, and does not remove or overwrite existing labels. Successfully applied and failed groups are reported separately; failed messages remain selected for retry. Reapplying an already-added Gmail label is safe and idempotent.

The browser holds the Gmail OAuth token and makes these calls directly to Gmail. The local Jev relay is unchanged and receives neither label names nor Gmail message IDs.

## Jev judgments and report calculations

Each email is one structured Jev state. One TypeSafe System One request evaluates independent questions in parallel:

- Four Noul phishing/social-engineering signals: sensitive information request, identity conflict, deceptive link, and coercive pressure.
- One Score for overall phishing/social-engineering concern.
- One Choice for primary purpose: shopping/commercial, transactional, newsletter, personal correspondence, work/service, or other.
- One Noul estimating whether the account owner likely needs to act, respond, attend to a personal matter, or retain the message for a decision.

Code, not Jev, decides who is listed in To/Cc, parses addresses and URLs, applies risk bands, and computes report percentages. The report defines “needs attention” as an importance Noul of at least 0.70. It separately reports the proportion listed in To/Cc and the intersection (“Direct + attention”). All percentage denominators are successfully Jev-analyzed messages; Gmail-fetch or Jev failures are shown separately and excluded. Purpose breakdowns and risk bands are also advisory. The 0.70 threshold and current risk-band thresholds are provisional and are not validated accuracy claims.

The report does not call an email safe. A low risk band means only that the current questions and thresholds did not find strong signals in the captured portion. If text or links are truncated, coverage is marked limited. Jev receives sender, subject, body excerpt, minimized link text and hostname, and the coarse recipient relationship; the Gmail message ID, full To/Cc headers, alias list, and access token are not included in its state. URL-like text is reduced to its hostname, and URL paths, query parameters, and fragments are removed server-side before links are sent to Jev. Email excerpts can still contain sensitive text such as verification codes or personal information; the scan disclosure warns users before they opt in.

## API contracts

Individual check: `POST /analyze` with `{ "message": CapturedMessage }`.

Batch check: `POST /analyze-batch` with `{ "messages": BatchCapturedMessage[] }`, containing 1–20 entries. The relay caps each batch message at 8,000 body characters and 12 links, evaluates at concurrency 3, and returns one indexed outcome per submitted item:

```json
{
  "results": [
    { "index": 0, "result": {
      "band": "review",
      "score": 1.72,
      "confidence": 0.68,
      "signals": [],
      "coverage": "complete",
      "purpose": "work_or_service",
      "purposeConfidence": 0.81,
      "importanceProbability": 0.76,
      "likelyNeedsAttention": true
    }},
    { "index": 1, "error": "analysis_failed" }
  ]
}
```

Each message evaluation consumes one unit from the local relay's 20-analysis-per-minute IP limit; a full 20-message scan consumes the full window. Shared TypeSafe authentication/permission/rate-limit failures stop new batch calls, and unstarted rows are returned as `not_analyzed`. This prevents a bad key or exhausted Jev quota from causing a cascade of repeated requests.

## Local test steps

1. Follow [`howtorun.md`](howtorun.md) to configure the Google OAuth client and local Jev relay.
2. Type-check the relay with `npm run typecheck` in `server/`.
3. Run the label helper tests with `node --test extension/scanner/gmail-labels.test.mjs`.
4. Load/reload `extension/` from `chrome://extensions`; visit Gmail and click the extension icon.
5. For the existing single-message flow, capture an expanded message, inspect the preview, then choose **Analyze with Jev**.
6. For batch review, open **Open batch scanner**, add any owned aliases, and choose **Connect and scan latest 20**. Approve read-only Gmail access for scanning; only after you click **Apply selected labels** should Chrome request `gmail.modify`.
7. Confirm the connected mailbox is expected, then compare report rows and category/To-Cc percentages with a few known messages. Check that failures appear as unavailable rather than low-risk.
8. Inspect suggested-label chips on known, non-sensitive messages. Verify purpose confidence below 0.50 does not suggest a purpose label, low risk does not suggest **Risk Review**, and absent To/Cc is worded as **Not Listed in To-Cc**.
9. Select one test message and click **Apply selected labels**. Confirm only that message receives the displayed labels in Gmail. Confirm existing labels remain, failed outcomes are visible, and scanning again without selecting/applying makes no additional mailbox changes.

No live Jev analysis has been exercised here; it needs the user's configured Google OAuth client, Google consent, and Jev API key. Use messages whose content you are comfortable sending to TypeSafe for evaluation.

## Cross-component impact and remaining work

- **Manifest → scanner:** identity/storage permissions, Gmail host access, and OAuth config support the new scanner without weakening the existing active-tab capture flow.
- **Scanner → Gmail labels API:** `gmail.modify` is required for the optional write flow. It runs only after explicit row selection and Apply; labels are add-only, and Gmail IDs/labels remain in the extension.
- **Scanner → relay:** Gmail IDs and raw recipient headers stay in the extension; the relay receives bounded content plus the computed recipient enum.
- **Relay → Jev:** batch validation, per-email rate accounting, bounded concurrency, generic row failures, URL minimization, and server-only API credentials keep provider integration behind one local boundary.
- **Analyzer → both UIs:** one shared response now includes risk, purpose, and attention fields; both the single-message popup and the batch report render the new judgments.
- **Docs:** setup now covers OAuth as well as Jev; the distinction between a local personal prototype and publicly verified Gmail access is explicit.

- **Tests:** Node's built-in test runner covers label suggestion rules, explicit-selection grouping, label reuse/creation, add-only request bodies, authorization denial, and partial application.

Before broader use, test MIME edge cases and the real mailbox layout; validate the recipient heuristics for aliases, Bcc, forwarding, and mailing lists; build a labeled test set to calibrate Jev questions and thresholds; and complete Google OAuth restricted-scope verification/security assessment plus proper service authentication before public distribution.

## References

- [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Chrome extension OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Gmail API `messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail API `messages.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail API `labels.create`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create)
- [Gmail API `messages.batchModify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify)
- [Gmail API scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe state](https://docs.typesafe.ai/concepts/state)
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul)
- [TypeSafe Score](https://docs.typesafe.ai/primitives/score)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
