# Inbox Signal

Inbox Signal is a Chrome Manifest V3 extension that captures the currently open Gmail message on demand, then asks TypeSafe Jev to assess phishing and social engineering signals through a local Node.js relay.

## Start the local Jev relay

1. Use Node.js 20.6 or newer (the relay uses Node's built-in `.env` loading).
2. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
3. Select this repository's `extension/` directory and copy its extension ID.
4. In `server/`, copy `.env.example` to `.env`. Set `TYPESAFE_API_KEY` to your Jev key and `EXTENSION_ID` to the ID shown by Chrome. Keep `server/.env` private; it is ignored by Git.
5. From `server/`, run `npm install` once, then `npm run dev`.
6. Visit `http://127.0.0.1:8787/health`; the response should be `{"status":"ok"}`.
7. Reload the extension in `chrome://extensions`. Open a Gmail email, choose **Capture open message**, review the captured sender and subject, then choose **Analyze with Jev**.

The relay binds only to `127.0.0.1` and allows the configured extension ID. It is for local development and is not a deployable public service. The popup requires a second click to send the captured message to TypeSafe. Link paths, query strings, and fragments are removed before the relay sends link destinations to Jev.

To type-check the server, run `npm run typecheck` from `server/`. For the full design, provisional risk rules, privacy boundaries, and future deployment work, see [implementation.md](implementation.md).
