# Inbox Signal

A Chrome Manifest V3 extension scaffold for inspecting the currently open Gmail message. This version captures the subject, sender, visible body, and links on demand and shows a local preview. It does not call Jev or assign a risk verdict yet.

## Run it

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** and choose **Load unpacked**.
3. Select this repository's `extension/` directory.
4. Open a Gmail message, click **Inbox Signal**, then **Capture open message**.

There is no build step or dependency install. The extension requests `activeTab` and `scripting` only. It reads Gmail when **Capture open message** is clicked; it has no persistent Gmail host permission.

For the Jev architecture, API token handling, and remaining work, see [implementation.md](implementation.md).
