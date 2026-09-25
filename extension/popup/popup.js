const captureButton = document.getElementById("capture");
const statusText = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const messageSection = document.getElementById("message");

let gmailTabId = null;

function setStatus(text, state = "") {
  statusText.textContent = text;
  statusDot.className = `status-dot ${state}`.trim();
}

function isGmailTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "mail.google.com";
  } catch {
    return false;
  }
}

async function findGmailTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isGmailTab(tab.url)) {
      setStatus("Open Gmail in this tab to continue.");
      return;
    }

    gmailTabId = tab.id;
    captureButton.disabled = false;
    setStatus("Gmail is ready. Open an email to capture it.", "ready");
  } catch {
    setStatus("Could not inspect the active tab.", "error");
  }
}

captureButton.addEventListener("click", async () => {
  if (gmailTabId === null) return;

  captureButton.disabled = true;
  messageSection.hidden = true;
  setStatus("Reading the open message…");

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: gmailTabId },
      files: ["content/extract-message.js"]
    });
    const captured = injection?.result;

    if (!captured?.ok) {
      setStatus(captured?.reason || "Open an email in Gmail and try again.", "error");
      return;
    }

    // Show metadata only; the captured body and URLs are discarded after this preview.
    document.getElementById("message-title").textContent = captured.message.subject;
    document.getElementById("sender").textContent = captured.message.sender.email
      ? `${captured.message.sender.name} <${captured.message.sender.email}>`
      : captured.message.sender.name;
    document.getElementById("body-size").textContent = `${captured.message.body.length.toLocaleString()} characters${captured.message.bodyTruncated ? " (preview limit)" : ""}`;
    document.getElementById("link-count").textContent = `${captured.message.links.length}${captured.message.linksTruncated ? "+" : ""}`;
    messageSection.hidden = false;
    setStatus("Message captured locally. Jev analysis is not connected yet.", "ready");
  } catch {
    setStatus("Could not read this message. Refresh Gmail and try again.", "error");
  } finally {
    captureButton.disabled = false;
  }
});

findGmailTab();
