# How to run Inbox Signal

Inbox Signal runs as an unpacked Chrome extension plus a local Node.js relay. It can inspect one open Gmail message, or—after Google OAuth setup—review up to the latest 20 messages in Gmail's Inbox. Scanning is report-only. Gmail labels are changed only for messages you select after reviewing the suggestions and explicitly apply.

## Requirements

- Google Chrome 105 or newer
- Node.js 20.6 or newer
- A TypeSafe Jev API key
- A Google Cloud OAuth client configured for this extension (batch scanning only)

## 1. Load the extension and copy its ID

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this project's `extension/` directory.
4. Copy the extension ID shown on the extension card. Keep the project in the same location so the unpacked extension ID remains the same.

## 2. Configure Gmail OAuth (batch scanner and optional labels)

The single-open-message feature does not need Gmail API OAuth. The batch scanner does; it needs the OAuth client ID to be placed in the manifest before the first scan.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. For personal testing, set up the app for testing and add the Google account you will scan as a test user. Keep `https://www.googleapis.com/auth/gmail.readonly` and add `https://www.googleapis.com/auth/gmail.modify` in **Google Auth Platform → Data Access**. Scanning requests only read-only access; the broader `gmail.modify` permission is requested only when you click **Apply selected labels**. Google may describe it as allowing read, compose, and send access, but Inbox Signal uses it only to create/apply selected labels and does not compose or send email.
3. Create an OAuth client ID with application type **Chrome Extension**. Enter the extension ID copied above as the Item ID.
4. Copy the generated client ID (it ends in `.apps.googleusercontent.com`). In `extension/manifest.json`, replace:

   ```json
   "client_id": "REPLACE_WITH_GOOGLE_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com"
   ```

   with the generated ID. Do not put a client secret in the extension.
5. Return to `chrome://extensions` and reload Inbox Signal. If Google shows an unverified-app warning in testing mode, confirm the selected test account and OAuth consent configuration before proceeding.

Google classifies Gmail message read/modify scopes as restricted. For personal development/testing, keep the consent screen in Testing and authorize only your test account; Google may show an unverified-app warning. Public distribution requires restricted-scope verification, and sending restricted Gmail data to Jev through a server may require a security assessment. This project remains a local personal prototype; see Google's [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes) before distributing it.

## 3. Configure the Jev relay

1. Copy `server/.env.example` to `server/.env`.
2. Set these values:

   ```dotenv
   TYPESAFE_API_KEY=your_typesafe_api_key
   EXTENSION_ID=the_id_copied_from_chrome
   PORT=8787
   ```

Keep `server/.env` private. It is ignored by Git. The Jev key stays in the local server; it is never bundled into the extension. The Google OAuth token stays in Chrome and is not sent to the relay.

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

## Review one open message

1. Open Gmail and expand the message you want to inspect.
2. Click the Inbox Signal toolbar icon, then **Capture open message**.
3. Confirm the displayed sender and subject are the ones you intended to analyze.
4. Click **Analyze with Jev**. The popup shows phishing-risk signals, message purpose, and Jev's estimated need for attention.

## Review up to 20 Inbox messages

1. Click the Inbox Signal icon and choose **Open batch scanner**.
2. Optionally add any Gmail aliases that should count as yours. The extension stores those aliases locally in Chrome and does not send them to Jev.
3. Read the disclosure, then click **Connect and scan latest 20**. On first use, choose the Google account and approve read-only Gmail access.
4. Confirm the connected mailbox shown at the top is the account you intended to scan.
5. Review the snapshot and message-by-message rows. Percentages use successfully analyzed messages only. “Listed in To or Cc” is a header match; “Direct + attention” combines that deterministic match with Jev's provisional 70% attention threshold.

## Apply suggested Gmail labels

The report proposes labels only for successfully analyzed messages. Purpose labels are suggested when Jev's purpose confidence is at least 0.50. Other suggestions are **Likely Important** when Jev's attention estimate crosses its current threshold, **Risk Review** for Jev risk bands `review` or `high`, and **Not Listed in To-Cc** when local header parsing finds no owned address in To/Cc. “Risk Review” is not a phishing verdict, and “Not Listed in To-Cc” does not rule out Bcc, forwarding, mailing lists, or aliases.

1. Inspect each message and its suggested-label chips.
2. Check only the messages you want labeled. All checkboxes start unchecked.
3. Click **Apply selected labels**. Inbox Signal reuses labels that already exist and creates missing ones.
4. The extension only adds labels; it does not remove existing labels or archive, trash, send, or mark messages read. Failed rows remain selected for a retry; successful rows show an applied status.

Label selections and scan results are held in page memory only. On the first label action, Chrome may prompt for the additional `gmail.modify` permission; approve it only if you want to continue. The Gmail API receives message IDs and label IDs for the explicit action; email contents are not sent again for labeling.

## Automated label checks

From the project root, run:

```sh
node --test extension/scanner/gmail-labels.test.mjs
```

These tests use mocked Gmail responses and do not connect to Gmail or change mailbox data. To test the complete flow, use a known, non-sensitive message, select only that row, review every proposed label, then click **Apply selected labels**. Confirm the resulting labels in Gmail and verify that unselected messages were untouched.

The scanner retrieves message details from Gmail, performs To/Cc matching locally, and sends only the bounded message fields plus a coarse recipient relationship to the local relay. Jev receives the email subject, sender, text excerpt, link text and destination hostnames; URL-like text and link paths/query strings are reduced to hostnames before the Jev request. Email text may still contain personal or security details, so scan only messages you are comfortable sending to TypeSafe. The scanner ignores attachments and does not save messages or results. A message not listed in To/Cc may still have arrived through Bcc, forwarding, a mailing list, or an alias you did not enter.

A full scan can use 20 Jev analyses and consumes the relay's full 20-analysis-per-minute allowance. The attention and risk thresholds are provisional and are not guaranteed detection rates.

## Stop the relay

In the terminal running `npm run dev`, press **Ctrl+C**.

## Troubleshooting

- **Google OAuth client is not configured:** replace the placeholder `client_id` in `extension/manifest.json`, save, and reload the extension.
- **Google rejects or blocks consent:** check the OAuth consent screen, add the scanning account as a test user, verify the Gmail API is enabled, and confirm the Chrome Extension OAuth client uses the current extension ID. A Google Workspace administrator may also restrict third-party Gmail access.
- **The extension ID changed:** recreate/update the Chrome Extension OAuth client with the current ID and update `EXTENSION_ID` in `server/.env`; reload the extension and restart the relay.
- **Gmail scan access denied:** check that the OAuth consent screen includes `gmail.readonly`, that the Gmail API is enabled for the same Google Cloud project, and that you approved read-only access.
- **Label access denied:** check that the OAuth consent screen includes `gmail.modify` and that you approved the additional request after clicking **Apply selected labels**. Reload the extension after code changes.
- **The connected mailbox is not the intended account:** stop before reviewing results, then use Chrome's Google account chooser/sign-in to select the correct account and scan again.
- **The relay says origin not allowed:** compare `EXTENSION_ID` in `server/.env` with the ID in `chrome://extensions`, then restart the relay.
- **Jev analysis is unavailable:** check that the relay is running and `/health` returns `{"status":"ok"}`. Confirm the key is set in `server/.env` and is active.
- **Some rows could not be analyzed:** a transient Jev/provider error or rate limit may have stopped the remaining batch. Check the relay terminal for error names only, wait a minute if rate-limited, and retry.
- **Some emails appear not addressed to you:** inspect their To/Cc headers in Gmail. Bcc, forwarding, and unlisted aliases cannot be distinguished by this header-only check.
- **You see limited coverage:** the body exceeded 8,000 characters or the link list exceeded 12 entries. The report says when this happens; inspect the full message manually.

For the architecture, limitations, data boundaries, and Google OAuth requirements, see [implementation.md](implementation.md).
