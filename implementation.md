# Inbox Signal implementation

## Goal and supported flows

Inbox Signal is an on-demand Chrome extension for reviewing Gmail email. It has two flows:

1. Capture the currently open, expanded message in Gmail and review it individually.
2. Scan up to 20 eligible messages from Gmail's Inbox, then show category, recipient-header, attention, and phishing-risk summaries. A conversation is eligible only when none of its messages has one of the nine Inbox Signal labels. The UI calls this **Connect and scan latest 20 eligible**.

Scanning is report-only: a scan never sends, archives, labels, deletes, marks read, or otherwise changes email. After reviewing the report, the user may explicitly select analyzed messages and apply suggested Gmail labels. The batch flow reads message bodies, but does not fetch or analyze attachments.

## Architecture and data flow

```text
Single-message flow
Gmail DOM → user-invoked content script → popup preview/consent → local relay → Jev → risk + triage result

Batch flow
User click → Chrome Identity OAuth → Gmail API (profile, paged Inbox IDs, conversation label metadata, then up to 20 full messages)
           → local To/Cc comparison + text/MIME parsing → batch request to local relay
           → bounded Jev calls → report page (percentages, categories, recipient relationship, evidence)

Optional label action
User selects analyzed rows → explicit Apply click → Chrome Identity OAuth → Gmail labels.list/create
                          → Gmail messages.batchModify (addLabelIds only) → per-row outcome
```

The extension gets the known Inbox Signal label IDs from `users.labels.list`, then calls `users.messages.list` with `labelIds=INBOX` and `maxResults=20`. For each page, it gets unique conversation metadata with `users.threads.get?format=minimal` and compares the returned messages' label IDs with the Inbox Signal IDs. It skips the whole conversation if any message has one of those labels, then follows `nextPageToken` until it has up to 20 unlabelled messages or Gmail has no more Inbox results. This ID-based check avoids relying on Gmail search-query parsing for custom label names. Full message details are fetched only for the candidates used to fill the report; a failed label-metadata check is shown as unavailable and is not sent to Jev. Gmail documents that thread labels summarize labels on any message in a thread, while a message label is not automatically copied to other messages. Google's [list-messages guide](https://developers.google.com/workspace/gmail/api/guides/list-messages) documents newest-first order and pagination; the [`threads.get` reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get) documents the minimal response; the [label guide](https://developers.google.com/workspace/gmail/api/guides/labels) explains message/thread label behavior.

Eligibility is based on applied labels, not a separate processing history. Once any message in a conversation has an Inbox Signal label, future scans skip that whole conversation, including when one of its suggestions has not been applied. A conversation that was only analyzed, or had no suggestions applied, remains eligible and can be sent to Jev again on a later scan. Removing all Inbox Signal labels from its messages in Gmail makes the conversation eligible again. Other Gmail labels do not affect eligibility. Because adding a label to one message makes it visible on the conversation, a new reply in that already-labelled conversation is also skipped.

The Chrome Identity API provides the OAuth access token directly to the extension; it is never sent to the local relay or Jev. Scanning requests the manifest's `gmail.readonly` scope and uses the token for profile, label list, message list, thread metadata and message reads. Only after **Apply selected labels** does the scanner request a token with the per-call scope override `[gmail.modify]`, used for label list/create and add-only batch modification. This broader scope also permits actions such as composing/sending that the extension does not implement. Chrome can reuse cached tokens and prior consent; a new prompt is shown only when needed.

All scan calls are read-only. The scanner checks conversation label IDs with concurrency 4 before fetching full messages, then reads at most 20 candidates with concurrency 4. It extracts the first readable plain-text part (or HTML text as a fallback) and skips MIME parts with a nonempty `filename`. It never calls the attachment download endpoint; attachment/MIME edge cases still need validation. Body text is capped at 8,000 characters per message; at most 12 links are sent to the relay.

The extension compares `To` and `Cc` addresses with the authenticated Gmail profile address plus optional user-entered aliases. That comparison happens in the browser. Alias addresses are stored in `chrome.storage.local` and are not sent to the relay or Jev. The server receives only one of these relationship labels: `to_me`, `cc_me`, `not_listed`, or `unclear`. Not listed in To/Cc is not proof of a misdelivery: Bcc, forwarding, mailing lists, and unregistered aliases can explain it.

```text
Gmail API ──OAuth token──> extension only
Gmail content ───────────> extension memory ──> 127.0.0.1 relay ──> Jev
To/Cc header fields ─────> local comparison only; not separately included in the Jev payload
Aliases ─────────────────> chrome.storage.local only
```

The local Node relay binds to `127.0.0.1`, checks the exact configured extension origin, validates payloads, strips URL paths/query strings/fragments before Jev sees link destinations, and does not log email contents. CORS origin checks are not full authentication; this service must not be exposed beyond the local development machine without real authentication and deployment hardening.

## Permissions and OAuth setup

The extension requires `identity` and `storage`, Gmail API and local-relay host permissions, and the manifest scope `https://www.googleapis.com/auth/gmail.readonly`. `activeTab` and `scripting` remain for the individual-message flow. Chrome 105 or newer is required for the promise-based Identity API used here. On explicit label application, the scanner uses Chrome Identity's per-call scopes override to request `https://www.googleapis.com/auth/gmail.modify`; Google Auth Platform must list both scopes. Keep the manifest's default scope read-only to preserve this flow. The narrower `gmail.labels` scope can create labels but is insufficient for [assigning them through `messages.batchModify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify).

The manifest contains the configured Chrome Extension OAuth client ID. In Google Auth Platform → Data Access, the project must include both `gmail.readonly` and `gmail.modify`; keep the app in Testing and the scanning account among test users for personal development. Scanning continues to use its existing read-only authorization. Chrome requests `gmail.modify` only if the user explicitly applies labels. Google may show an unverified-app warning while the OAuth app is in testing. These Gmail scopes are restricted; public distribution requires Google's restricted-scope verification, and transmitting restricted Gmail data to Jev through a server can trigger a security assessment. Treat this implementation as local, personal development until those requirements are addressed.

The OAuth client's **Item ID** must match the loaded extension's ID from `chrome://extensions`. The current manifest has no stable `key`, so an unpacked install on another computer or at another path can have a different ID. Register a matching Chrome Extension client and use its client ID in that installation's manifest. Separately set `EXTENSION_ID` in the local relay's environment to the loaded extension ID. Reload the extension after manifest changes; restart the relay after environment changes. See [the setup guide](howtorun.md#using-another-computer-or-moving-the-project).

The Jev key remains a server secret in `server/.env` as `TYPESAFE_API_KEY`; never put it in the extension, manifest, or browser storage. The existing local relay is for personal development, not a multi-user production service.

## Optional label suggestions and Gmail writes

The implementation is split between these files:

| File | Responsibility |
| --- | --- |
| [`extension/scanner/scanner.js`](extension/scanner/scanner.js) | Exclude categorised messages from Inbox scans, request scopes, render suggestions, track explicit selections and show application results. |
| [`extension/scanner/gmail-labels.mjs`](extension/scanner/gmail-labels.mjs) | Define the canonical label names, map results to suggestions, group selected message IDs, reuse/create labels and make Gmail writes. |
| [`server/src/analyzer.ts`](server/src/analyzer.ts) | Return purpose/confidence, attention flag and risk band used by the label rules. |
| [`extension/scanner/gmail-labels.test.mjs`](extension/scanner/gmail-labels.test.mjs) | Exercise the helper with mocked Gmail responses. |

### Label catalogue

Label suggestions use the existing analysis result and local To/Cc comparison. Every eligible row needs a Gmail message ID and a successful analysis. Each purpose label below additionally requires the returned `purposeConfidence >= 0.50`.

| Exact Gmail label name | Condition |
| --- | --- |
| `Inbox Signal - Shopping and Commercial` | Purpose is `shopping_commercial`. |
| `Inbox Signal - Transactional and Account Notices` | Purpose is `transactional`. |
| `Inbox Signal - Newsletters and Digests` | Purpose is `newsletter`. |
| `Inbox Signal - Personal Correspondence` | Purpose is `personal_correspondence`. |
| `Inbox Signal - Work and Services` | Purpose is `work_or_service`. |
| `Inbox Signal - Other` | Purpose is `other`. |
| `Inbox Signal - Likely Important` | `likelyNeedsAttention === true`, computed on the relay at an attention probability of at least 0.70. |
| `Inbox Signal - Not Listed in To-Cc` | Local `recipientRelation === "not_listed"`: at least one To/Cc address was parsed, but none matched the profile address or aliases. `unclear` does not qualify. |
| `Inbox Signal - Risk Review` | The relay's risk band is `review` or `high`. |

A message can receive one purpose label plus any of the three other labels, for a maximum of four suggestions. Purpose confidence is rounded to two decimal places by the relay before the extension applies its 0.50 threshold. The attention flag is computed before probability rounding, so a displayed 70% near the boundary can still have a false attention flag. Report category counts include all successful analyses, including those below the purpose-label threshold.

These are ordinary custom Gmail labels. They do not set Gmail's built-in Important marker, Spam label, or Promotions/category tabs. **Risk Review** can result from limited evidence or uncertainty as well as risk signals. **Not Listed in To-Cc** is a header observation; Bcc, forwarding, mailing lists and aliases remain possible explanations.

### Selection, writes and retry behaviour

All message-selection checkboxes begin unchecked. A row has a checkbox only if it was successfully analyzed and has at least one suggested label. The master checkbox selects all unapplied rows with suggestions; it is checked when all such rows are selected and indeterminate for a partial selection. Individual rows can still be cleared after selecting all. Selecting a row applies its complete suggestion set; individual suggested labels cannot be edited or deselected in the current UI. Apply is disabled with no eligible selection. While applying, Scan, Apply and the selection checkboxes are disabled.

On explicit **Apply selected labels**, the extension:

1. Requests a `gmail.modify` token, checking that scope when Chrome returns `grantedScopes`.
2. Calls `users.labels.list` and reuses exact-name matches. It creates only the missing labels needed for the selected rows, with `labelListVisibility: "labelShow"` and `messageListVisibility: "show"`. A creation response of HTTP 409 causes a fresh list lookup to reuse the matching label.
3. Groups selected message IDs by their exact suggestion set. After all required labels exist, it sends the groups sequentially to `users.messages.batchModify` with `ids` and `addLabelIds` only. No email content or `removeLabelIds` is sent.
4. Marks successful groups applied, clears their selection, and disables their checkboxes for that report. At the first batch-update error, it stops sending later groups; both the failed group and unattempted groups are displayed as failed and remain selected for retry.

The writes are not a transaction. Labels created before a later creation error remain in Gmail even when no message updates start. Earlier successful message updates remain after a later group fails. A network error can leave an uncertain outcome if Gmail applied a request before its response was lost; retrying the same label additions does not create duplicate assignments. The helper does not read messages back to verify assignments after a successful API response.

Label definitions and assignments persist in Gmail after closing the scanner. Selections, suggestions and per-row statuses exist only in page memory and reset with a new report or page reload; only aliases are stored in `chrome.storage.local`. Rescanning does not remove old labels or reconcile changed categories. Remove unwanted labels manually in Gmail; the extension has no undo, removal, scheduled scan or Gmail filter feature. Writes target selected message IDs, not every message in a conversation; Gmail may display their labels on the conversation containing them. See [Gmail's message/thread label behaviour](https://developers.google.com/workspace/gmail/api/guides/labels).

The browser makes the write calls directly to Gmail. Applying labels does not call the Jev relay or use additional Jev analyses. Gmail message IDs and the explicit suggested-label fields are excluded from the analysis request. Keep the same Google account active between scanning and applying: the current code obtains another Identity token for `users/me` and does not recheck the mailbox profile before writing.

## Jev judgments and report calculations

Each email is one structured Jev state. One TypeSafe System One request evaluates independent questions in parallel:

- Four Noul phishing/social-engineering signals: sensitive information request, identity conflict, deceptive link, and coercive pressure.
- One Score for overall phishing/social-engineering concern.
- One Choice for primary purpose: shopping/commercial, transactional, newsletter, personal correspondence, work/service, or other.
- One Noul estimating whether the account owner likely needs to act, respond, attend to a personal matter, or retain the message for a decision.

Code, not Jev, decides who is listed in To/Cc, parses addresses and URLs, applies risk bands, and computes report percentages. The report defines “needs attention” as an importance Noul of at least 0.70. It separately reports the proportion listed in To/Cc and the intersection (“Direct + attention”). All percentage denominators are successfully Jev-analyzed messages; Gmail-fetch or Jev failures are shown separately and excluded. Purpose breakdowns and risk bands are also advisory. The 0.70 threshold and current risk-band thresholds are provisional and are not validated accuracy claims.

The relay computes risk bands in order: `high` when the concern score is at least 2.30 or any of the four Noul values is at least 0.82; otherwise `review` when the score is at least 1.15, any Noul is at least 0.56, score confidence is below 0.55, a visible hostname differs from its destination, or the body/links are truncated (including the scanner's unavailable-body flag); otherwise `low`. The batch report displays Jev's risk-score confidence as a percentage; below 55% it adds the manual-review signal and forces the risk band to `review`. This is TypeSafe's confidence in the selected Score level, not the probability that a message is phishing. The threshold remains provisional and needs calibration against a labelled email set. The label helper consumes the computed band and does not run a separate phishing classification.

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
6. For batch review, open **Open batch scanner**, add any owned aliases, and choose **Connect and scan latest 20 eligible**. The report skips conversations with any Inbox Signal label and can reach older unlabelled conversations to fill the batch. Approve read-only Gmail access for scanning. After you click **Apply selected labels**, Chrome requests a modify token and prompts for consent if it has not already been granted.
7. Confirm the connected mailbox is expected, then compare report rows and category/To-Cc percentages with a few known messages. Check that failures appear as unavailable rather than low-risk.
8. Inspect suggested-label chips on known, non-sensitive messages. Verify purpose confidence below 0.50 does not suggest a purpose label and low risk does not suggest **Risk Review**. Parsed To/Cc addresses with no owned-address match qualify for **Not Listed in To-Cc**; missing/unparseable To/Cc addresses produce `unclear` and no recipient label.
9. Select one test message and click **Apply selected labels**. Confirm only that message receives the displayed labels in Gmail. Confirm existing labels remain and failed outcomes are visible. If the test message received an Inbox Signal label, confirm a later scan skips it; an unselected message remains eligible.

### Verification record

Documentation and Gmail API v1 review started at `2026-09-26T12:02:17Z`. The local checks for this documentation review passed: all 8 tests in `gmail-labels.test.mjs`, and `npm run typecheck` in `server/`. Docker's daemon was unavailable, so these ran with the already installed Node.js and project dependencies. No dependencies were installed. The project has no separate build or lint scripts.

The tests cover suggestion rules, grouping, no-selection behaviour, label reuse/creation, add-only bodies, denied label-list access, creation failure and partial group success using mocks. They do not cover the Gmail thread-label eligibility check, or validate Chrome consent, a real Gmail write, message read-back, token refresh or account switching. The current scanner changes passed JavaScript syntax checks, `npm run typecheck` in `server/`, and `git diff --check`; no automated tests or live Gmail scan, mutation or Jev request were run for this change. Use messages whose content you are comfortable sending to TypeSafe for the manual checks above.

## Cross-component impact and remaining work

- **Manifest → scanner:** identity/storage permissions, Gmail host access, and OAuth config support the new scanner without weakening the existing active-tab capture flow.
- **Scanner → Gmail labels API:** `gmail.modify` is required for the optional write flow. It runs only after explicit row selection and Apply; Gmail receives selected message IDs, label names for creation, and label IDs for assignment. Labels are added without removing existing assignments.
- **Scanner → relay:** Gmail IDs and raw recipient headers stay in the extension; the relay receives bounded content plus the computed recipient enum.
- **Relay → Jev:** batch validation, per-email rate accounting, bounded concurrency, generic row failures, URL minimization, and server-only API credentials keep provider integration behind one local boundary.
- **Analyzer → both UIs:** one shared response now includes risk, purpose, and attention fields; both the single-message popup and the batch report render the new judgments.
- **Docs:** [howtorun.md](howtorun.md) is the setup and usage guide, including per-computer OAuth configuration and optional label application.
- **Remaining checks:** live consent and label application, revalidating the mailbox before a write if the account changes, and expired-token recovery. The current scanner converts Chrome Identity failures to a generic sign-in error and does not explicitly evict rejected cached tokens.
- **Credential file:** this checkout still tracks `server/.env` in Git despite the ignore pattern. Stop tracking it before committing credentials; ignore rules do not remove already tracked files. Credential values and Git history were not inspected in this review.

Before broader use, test MIME edge cases and the real mailbox layout; validate the recipient heuristics for aliases, Bcc, forwarding, and mailing lists; build a labeled test set to calibrate Jev questions and thresholds; and complete Google OAuth restricted-scope verification/security assessment plus proper service authentication before public distribution.

## References

- [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Chrome extension OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Gmail API `messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail message ordering and pagination](https://developers.google.com/workspace/gmail/api/guides/list-messages)
- [Gmail API `messages.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail API `labels.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list)
- [Gmail API `threads.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)
- [Gmail API `labels.create`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create)
- [Gmail API `messages.batchModify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify)
- [Gmail label and conversation behaviour](https://developers.google.com/workspace/gmail/api/guides/labels)
- [Gmail API scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe state](https://docs.typesafe.ai/concepts/state)
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul)
- [TypeSafe Score](https://docs.typesafe.ai/primitives/score)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
