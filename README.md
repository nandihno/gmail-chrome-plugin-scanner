# Inbox Signal

Inbox Signal is a Chrome Manifest V3 extension that checks an open Gmail message or creates an on-demand overview of up to the 20 newest Inbox messages. It uses Gmail's read-only API for the batch flow and TypeSafe Jev, through a local Node.js relay, for message purpose, attention, and phishing-risk judgments.

The batch report separates Jev's provisional “needs attention” estimate from deterministic To/Cc header matching. “Not listed in To/Cc” can also mean Bcc, forwarding, a mailing list, or an unlisted alias; it is not proof of a misdelivery. Inbox Signal does not modify messages or analyze attachments.

## Quick start

1. Load `extension/` unpacked from `chrome://extensions` and copy the extension ID.
2. For batch scanning, configure a Google Cloud OAuth client for that Chrome extension ID, enable the Gmail API, and replace the OAuth `client_id` placeholder in `extension/manifest.json`. The requested scope is Gmail read-only; see [howtorun.md](howtorun.md) for detailed steps and Google's restricted-scope caveats.
3. Copy `server/.env.example` to `server/.env`, then set `TYPESAFE_API_KEY`, `EXTENSION_ID`, and `PORT=8787`.
4. In `server/`, run `npm install`, `npm run typecheck`, then `npm run dev`.
5. Reload the extension. From the toolbar popup choose **Capture open message** for one email, or **Open batch scanner** to authorize Gmail and scan the latest 20 Inbox messages.

The Jev token remains in `server/.env`; Gmail OAuth tokens stay in Chrome. Email content is sent to Jev only after the user starts an analysis. See [howtorun.md](howtorun.md) for testing and troubleshooting, and [implementation.md](implementation.md) for architecture, data boundaries, and remaining work.
