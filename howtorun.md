# How to run Inbox Signal

Inbox Signal runs as an unpacked Chrome extension plus a local Node.js relay. The relay sends a message to TypeSafe Jev only after you choose **Analyze with Jev** in the extension.

## Requirements

- Google Chrome
- Node.js 20.6 or newer
- A TypeSafe Jev API key

## One-time setup

### 1. Load the extension and copy its ID

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this project's `extension/` directory.
4. Copy the extension ID shown on the extension card. The relay uses it to accept requests only from this extension.

### 2. Configure the Jev key

1. Copy `server/.env.example` to `server/.env`.
2. Edit `server/.env` and set these values:

   ```dotenv
   TYPESAFE_API_KEY=your_typesafe_api_key
   EXTENSION_ID=the_id_copied_from_chrome
   PORT=8787
   ```

Keep `server/.env` on your computer. It is ignored by Git; do not commit or share it.

### 3. Install server dependencies

From a terminal, run:

```sh
cd server
npm install
```

## Start the relay and extension

1. Start the relay from the `server/` directory:

   ```sh
   npm run dev
   ```

   Leave this terminal open while using the extension. The relay listens on `http://127.0.0.1:8787`.

2. Open `http://127.0.0.1:8787/health` in Chrome. It should show:

   ```json
   {"status":"ok"}
   ```

3. If you edited the extension files or manifest, return to `chrome://extensions` and press the extension's reload button.
4. Open Gmail and select an email so its message is expanded.
5. Click the Inbox Signal icon, then click **Capture open message**.
6. Check that the sender and subject shown are the email you intended to inspect.
7. Click **Analyze with Jev** to send the captured message for analysis and display the result.

Each analysis sends the captured subject, sender, body text, and link text/destinations to TypeSafe and uses your Jev account. Link paths and query strings are removed before link destinations are sent. The extension does not scan the inbox automatically.

## Stop the relay

In the terminal running `npm run dev`, press **Ctrl+C**.

## Type-check the relay

From the `server/` directory, run:

```sh
npm run typecheck
```

## Troubleshooting

- **The extension says Gmail is not open:** select a Gmail tab at `mail.google.com`, then reopen the extension popup.
- **No expanded message was found:** open the email itself, then capture it again. The current capture uses Gmail page selectors that may need updates if Gmail changes its layout.
- **Analysis is unavailable:** check that the relay is running and `/health` returns `{"status":"ok"}`. Confirm the API key and extension ID in `server/.env`, then reload the extension.
- **The relay exits immediately:** confirm `TYPESAFE_API_KEY` is set and `EXTENSION_ID` matches the ID shown in `chrome://extensions`.
- **The extension ID changed:** update `EXTENSION_ID` in `server/.env` to the current ID and restart the relay.
- **You see a limited-coverage result:** the captured message exceeded the text or link limit. Review the message manually as well.

The relay is for local development and binds only to your computer. See [implementation.md](implementation.md) for the architecture, current limitations, and work required before public deployment.
