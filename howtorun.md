# How to run Inbox Signal

Inbox Signal runs as an unpacked Chrome extension plus a local Node.js relay. It can inspect one open Gmail message or, after Google OAuth setup, review up to 20 messages from Gmail's Inbox. Scanning is report-only. Gmail labels are changed only for messages you select after reviewing the suggestions and clicking **Apply selected labels**.

## Requirements

- Google Chrome 105 or newer
- Node.js 20.6 or newer
- A TypeSafe Jev API key
- A Google Cloud OAuth client configured for this extension (batch scanning only)

## 1. Load the extension and copy its ID

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this project's `extension/` directory.
4. Copy the extension ID shown on the extension card. Check it again if you move the project or use another computer; this manifest has no stable extension `key`.

## 2. Configure Gmail OAuth (batch scanner and optional labels)

The single-open-message feature does not need Gmail API OAuth. The batch scanner does; it needs the OAuth client ID to be placed in the manifest before the first scan.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. For personal testing, set up the app for testing and add the Google account you will scan as a test user. Include both `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.modify` in **Google Auth Platform → Data Access**. Keep only `gmail.readonly` in the manifest's `oauth2.scopes`: scanning uses that default, and the scanner requests `gmail.modify` separately when you click **Apply selected labels**. Google may describe modification access as allowing read, compose, and send access; Inbox Signal uses it only for the label action and does not compose or send email. The narrower `gmail.labels` scope alone cannot assign labels to messages.
3. Create an OAuth client ID with application type **Chrome Extension**. Enter the extension ID copied above as the Item ID.
4. Copy the generated client ID (it ends in `.apps.googleusercontent.com`). Set `oauth2.client_id` in `extension/manifest.json` to this value. The current manifest already contains a client ID; confirm its Chrome Extension OAuth client is registered for the ID shown for this extension in `chrome://extensions`, and replace it if it is not. Do not put a client secret in the extension.
5. Return to `chrome://extensions` and reload Inbox Signal, then close and reopen any existing scanner page. If Google shows an unverified-app warning in testing mode, confirm the selected test account and OAuth consent configuration before proceeding.

Chrome may reuse cached tokens and existing consent, so it does not necessarily show a new permission prompt on each scan or label action.

Google classifies Gmail message read/modify scopes as restricted. For personal development/testing, keep the consent screen in Testing and authorize only your test account; Google may show an unverified-app warning. Public distribution requires restricted-scope verification, and sending restricted Gmail data to Jev through a server may require a security assessment. This project remains a local personal prototype; see Google's [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes) before distributing it.

## 3. Configure the Jev relay

1. If `server/.env` does not exist, copy `server/.env.example` to `server/.env`. Preserve your existing configuration if it is already present.
2. Set these values:

   ```dotenv
   TYPESAFE_API_KEY=your_typesafe_api_key
   EXTENSION_ID=the_id_copied_from_chrome
   PORT=8787
   ```

Keep `server/.env` private. Although `.gitignore` contains an ignore rule, this checkout still tracks that file. Ignore rules do not remove already tracked files; stop tracking it before committing credentials. Credential values and history were not inspected during the documentation review.

The Jev key stays in the local server; it is never bundled into the extension. The Google OAuth token stays in Chrome and is not sent to the relay. Keep `PORT=8787`: the extension's relay URLs and host permission currently use that port. Restart the relay after changing `.env`; the development command does not watch configuration changes.

## 4. Install and start

From a terminal:

```sh
cd server
npm install
npm run typecheck
npm run dev
```

Leave the terminal running. The relay listens on `http://127.0.0.1:8787`. Visit `http://127.0.0.1:8787/health`; it should return:

```json
{"status":"ok"}
```

## Using another computer or moving the project

The Google OAuth client ID, Chrome extension ID and relay setting must agree for each installation:

| Setting | Must match |
| --- | --- |
| Google Cloud Chrome Extension OAuth client's **Item ID** | The extension ID currently shown in `chrome://extensions`. |
| Manifest `oauth2.client_id` | The client ID of that matching Google Cloud client. |
| Relay `EXTENSION_ID` in `server/.env` | The extension ID currently shown in `chrome://extensions`. |

An OAuth client used on another computer will not work if its Item ID differs from this installation's extension ID. Create a matching Chrome Extension OAuth client for the new installation and set its client ID in the local manifest. Keep the previous client's configuration if the other installation still uses it. Enable the Gmail API and configure the scopes/test account in the Google Cloud project containing the new client.

Reload the extension and reopen the scanner after changing the manifest. Update `EXTENSION_ID` and restart the relay if the extension ID changed. The current manifest has no stable `key`, so check these settings whenever the unpacked extension is installed at a different path or on another computer.

## Review one open message

1. Open Gmail and expand the message you want to inspect.
2. Click the Inbox Signal toolbar icon, then **Capture open message**.
3. Confirm the displayed sender and subject are the ones you intended to analyze.
4. Click **Analyze with Jev**. The popup shows phishing-risk signals, message purpose, and Jev's estimated need for attention.

## Review up to 20 Inbox messages

1. Click the Inbox Signal icon and choose **Open batch scanner**.
2. Optionally add any Gmail aliases that should count as yours. The extension stores those aliases locally in Chrome and does not send them to Jev.
3. Read the disclosure, then click **Connect and scan latest 20 eligible**. On first use, choose the Google account and approve read-only Gmail access.
4. Confirm the connected mailbox shown at the top is the account you intended to scan.
5. Review the snapshot and message-by-message rows. Percentages use successfully analyzed messages only. “Listed in To or Cc” is a header match; “Direct + attention” combines that deterministic match with Jev's provisional 70% attention threshold. Each row shows Jev's risk-score confidence; a value below 55% adds a manual-review signal. This confidence describes how concentrated Jev's answer is among the risk-score levels, not the probability that the email is phishing. The threshold is provisional and has not been calibrated against a labelled email set.

Gmail returns messages newest first. The scanner checks label IDs across each conversation and skips a conversation if any message in it has an Inbox Signal label. It follows Gmail's result pages until it has up to 20 messages from unlabelled conversations or reaches the end of the Inbox. Other Gmail labels do not affect eligibility. A newly labelled reply in an already-labelled conversation is also skipped. Conversations you leave unselected or that receive no suggestions remain eligible and may be analysed again. See the [selection behaviour](implementation.md#architecture-and-data-flow).

The scanner retrieves message details from Gmail, performs To/Cc matching locally, and sends bounded message fields plus a coarse recipient relationship to the local relay. Jev receives the email subject, sender, text excerpt, link text and destination hostnames; URL-like text and link paths/query strings are reduced to hostnames before the Jev request. Email text may still contain personal or security details, so scan only messages you are comfortable sending to TypeSafe. The scanner skips named attachment parts and does not download attachments or save messages/results. A message not listed in To/Cc may still have arrived through Bcc, forwarding, a mailing list, or an alias you did not enter.

A full scan can use 20 Jev analyses and consumes the relay's full 20-analysis-per-minute allowance. The attention and risk thresholds are provisional and are not guaranteed detection rates.

## Apply suggested Gmail labels

The report proposes labels only for successfully analyzed messages. All names begin with `Inbox Signal - `; see the [exact names and rules](implementation.md#label-catalogue). A message can receive one purpose label and up to three additional labels:

- **Purpose:** the returned purpose confidence is at least 0.50.
- **Likely Important:** the relay's attention flag is true, using a probability threshold of 0.70 before rounding.
- **Risk Review:** the relay's computed risk band is `review` or `high`. Limited coverage or uncertainty can trigger this; it is not a phishing verdict.
- **Not Listed in To-Cc:** at least one To/Cc address was parsed, but none matched the mailbox address or entered aliases. Unclear headers do not qualify. Bcc, forwarding and mailing lists remain possible explanations.

1. Inspect each message and its suggested-label chips.
2. Leave the master checkbox clear and select messages individually, or check **Select all messages with suggested labels**. The master checkbox selects every successfully analyzed, unapplied row with at least one suggestion; rows without suggestions and rows already labeled are excluded. You can still clear individual rows after selecting all. All checkboxes start unchecked, and selecting a row applies every suggestion on it; individual label chips cannot be deselected.
3. Keep the same Google account active as the connected mailbox. The current implementation does not check the mailbox again before writing.
4. Click **Apply selected labels**. Chrome requests a `gmail.modify` token and may prompt for additional consent if needed. Inbox Signal reuses exact-name labels and creates only the missing labels needed for your selected messages.
5. Wait for the result. Scan, Apply and selection checkboxes are disabled during the action. Successful rows show an applied status, become unchecked and cannot be selected again in that report. Failed and unattempted rows remain selected for retry; the master checkbox reflects the remaining selectable rows.

The extension only adds labels; it does not remove existing labels or archive, trash, send, or mark messages read. These are custom labels, so **Likely Important** does not set Gmail's Important marker, and purpose labels do not change Gmail's category tabs. The action targets selected messages; Gmail may also display their labels on the containing conversation without applying them to every message in that conversation.

Labels are created before message updates start. Updates run in groups of messages with the same suggestions and stop at the first failure. Earlier successes remain; later unattempted groups are also shown as failed. A creation error can leave new labels in Gmail with no messages assigned. A lost network response can leave an uncertain result, but retrying the same additions does not duplicate label assignments. See [failure and retry details](implementation.md#selection-writes-and-retry-behaviour).

**Applied labels persist in Gmail.** Only scan results, selections and application statuses are held in page memory; they reset on a new report or page reload. Rescanning does not remove outdated labels, and future messages are not labeled automatically. Remove unwanted labels manually in Gmail; the extension has no undo or filter feature.

Label application goes directly from Chrome to Gmail and uses no additional Jev analyses. Gmail receives label names for creation and message/label IDs for assignment; email contents are not sent again for labeling.

## Automated label checks

From the project root, run:

```sh
node --test extension/scanner/gmail-labels.test.mjs
```

The eight tests use mocked Gmail responses and do not connect to Gmail or change mailbox data. They cover suggestion rules, grouping, no selection, label reuse/creation, add-only requests, denied access, creation failure and partial success. They do not exercise the Gmail thread-label check used to find eligible messages. Type-check the relay separately with `npm run typecheck` in `server/`; there are no separate build or lint scripts.

For a manual end-to-end check, use known, non-sensitive messages. Scan, select one row, review every proposed label, and click **Apply selected labels**. Confirm those labels appear on the selected message in Gmail, then scan again: its entire conversation should be skipped, while an unlabelled conversation should remain eligible. Confirm existing labels remain and unselected messages were untouched. Reload the extension and reopen the scanner before repeating the check. Mocked tests do not establish that Chrome consent, live Gmail writes, or the Gmail thread-label eligibility check work; see the [verification record](implementation.md#verification-record) for checks actually performed.

## Stop the relay

In the terminal running `npm run dev`, press **Ctrl+C**.

## Troubleshooting

- **Google OAuth client is not configured:** set `oauth2.client_id` in `extension/manifest.json` to a Chrome Extension OAuth client ID registered for this extension's current ID, then reload the extension.
- **Google sign-in does not complete / bad client ID:** the current scanner shows a generic sign-in error rather than the underlying Chrome Identity reason. Compare the OAuth client's Item ID with the current extension ID, confirm the matching client ID is in the manifest, add the scanning account as a test user, and verify the Gmail API is enabled. Reload the extension and reopen the scanner after manifest changes. A Google Workspace administrator may also restrict third-party Gmail access.
- **The extension ID changed or setup moved to another computer:** follow [the per-installation configuration steps](#using-another-computer-or-moving-the-project), including the matching OAuth client and relay `EXTENSION_ID`.
- **Gmail scan access denied:** check that the OAuth consent screen includes `gmail.readonly`, that the Gmail API is enabled for the same Google Cloud project, and that you approved read-only access.
- **Label access denied:** check that the OAuth consent screen includes `gmail.modify` and that you approved the additional request after clicking **Apply selected labels**. Reload the extension after code changes.
- **A message appears to have a label but is still being scanned:** confirm the Gmail extension was reloaded after the code update. Eligibility checks label IDs from Gmail's metadata for the whole conversation; if any Inbox Signal label remains on a message in that conversation, it should be skipped. Gmail displays a conversation label when any message in the conversation has it.
- **No messages are ready to review:** the Inbox may have no conversations without an Inbox Signal label. Remove all Inbox Signal labels from the conversation's messages to make it eligible again.
- **Every result says the risk judgment is uncertain:** check the displayed risk-score confidence. The manual-review signal is added below 55%; this is a provisional threshold and confidence is distinct from the probability of phishing.
- **No selectable checkbox / Apply is disabled:** failed analyses and rows with no suggestions cannot be selected. Low purpose confidence suppresses the purpose label; the other three rules can still qualify. Select an eligible row to enable Apply.
- **Some labels were applied but others failed:** earlier successful groups are kept. Failed and unattempted rows remain selected for retry; inspect the outcome and retry after resolving the access or network error. A new, empty label can remain after a later creation failure.
- **Old labels remain after a rescan:** this is expected. The extension only adds labels on Apply and does not remove/reconcile existing ones.
- **The connected mailbox is not the intended account:** do not apply labels. Use a Chrome profile signed in to the intended account and scan again; confirm the mailbox address before applying. Changing the account between scan and Apply is not guarded by a profile recheck.
- **Repeated Gmail authentication failures:** Chrome caches OAuth tokens; the current scanner does not explicitly clear a rejected token on HTTP 401. A retry alone is not guaranteed to refresh authorization.
- **The relay says origin not allowed:** compare `EXTENSION_ID` in `server/.env` with the ID in `chrome://extensions`, then restart the relay.
- **Jev analysis is unavailable:** check that the relay is running and `/health` returns `{"status":"ok"}`. Confirm the key is set in `server/.env` and is active.
- **Some rows could not be analyzed:** a transient Jev/provider error or rate limit may have stopped the remaining batch. Check the relay terminal for error names only, wait a minute if rate-limited, and retry.
- **Some emails appear not addressed to you:** inspect their To/Cc headers in Gmail. Bcc, forwarding, and unlisted aliases cannot be distinguished by this header-only check.
- **You see limited coverage:** the body exceeded 8,000 characters, the link list exceeded 12 entries, or readable body content was unavailable. Inspect the full message manually.

For the architecture, limitations, data boundaries, and Google OAuth requirements, see [implementation.md](implementation.md).
