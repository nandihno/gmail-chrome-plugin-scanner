# Inbox Signal

Inbox Signal is a Chrome Manifest V3 extension that checks an open Gmail message or creates an on-demand overview of up to 20 Inbox messages without an Inbox Signal label. It uses the Gmail API for the batch flow and TypeSafe Jev, through a local Node.js relay, for message purpose, attention, and phishing-risk judgments.

The batch report separates Jev's provisional “needs attention” estimate from deterministic To/Cc header matching. “Not listed in To/Cc” can also mean Bcc, forwarding, a mailing list, or an unlisted alias; it is not proof of a misdelivery. Scanning is report-only; applying suggested Gmail labels requires selecting messages and clicking **Apply selected labels**. Later scans skip messages that already have any Inbox Signal label and fill the batch with older, unlabelled Inbox messages. Attachments are not analyzed.

## Quick start

1. Load `extension/` unpacked from `chrome://extensions` and copy the extension ID.
2. For batch scanning and optional label application, configure a Google Cloud Chrome Extension OAuth client for that extension ID, enable the Gmail API, and set or verify `oauth2.client_id` in `extension/manifest.json`. Include `gmail.readonly` and `gmail.modify` in Google Auth Platform, keeping only read-only access in the manifest's default scopes. The scanner requests modification access separately when you explicitly apply labels. See [howtorun.md](howtorun.md) for setup and Google's restricted-scope caveats, including [configuration on another computer](howtorun.md#using-another-computer-or-moving-the-project).
3. If `server/.env` does not exist, copy `server/.env.example` to it, then set `TYPESAFE_API_KEY`, `EXTENSION_ID`, and `PORT=8787`. Preserve existing settings. This checkout still tracks `.env` despite its ignore rule; see the [credential-file note](howtorun.md#3-configure-the-jev-relay) before committing.
4. In `server/`, run `npm install`, `npm run typecheck`, then `npm run dev`.
5. Reload the extension and reopen the scanner after manifest changes; restart the relay after `.env` changes. From the toolbar popup choose **Capture open message** for one email, or **Open batch scanner** to authorize Gmail and scan up to 20 eligible Inbox messages.

The Jev token remains in `server/.env`; Gmail OAuth tokens stay in Chrome. Email content is sent to Jev only after the user starts an analysis. Gmail labels are created/applied only to selected messages after an explicit action; no messages or label assignments are changed by scanning alone. Each selected row receives its full suggestion set. Applied labels persist in Gmail; rescanning does not remove them or automatically label future messages. See the [label catalogue](implementation.md#label-catalogue), [howtorun.md](howtorun.md) for usage and troubleshooting, and [implementation.md](implementation.md) for architecture, data boundaries, and remaining work.
