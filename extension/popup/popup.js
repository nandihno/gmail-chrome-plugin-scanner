const captureButton = document.getElementById("capture");
const statusText = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const messageSection = document.getElementById("message");
const analyzeButton = document.getElementById("analyze");
const assessmentSection = document.getElementById("assessment");
const ANALYSIS_ENDPOINT = "http://127.0.0.1:8787/analyze";

let gmailTabId = null;
let capturedMessage = null;

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
  analyzeButton.hidden = true;
  assessmentSection.hidden = true;
  capturedMessage = null;
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

    capturedMessage = captured.message;
    document.getElementById("message-title").textContent = capturedMessage.subject;
    document.getElementById("sender").textContent = capturedMessage.sender.email
      ? `${capturedMessage.sender.name} <${capturedMessage.sender.email}>`
      : capturedMessage.sender.name;
    document.getElementById("body-size").textContent = `${capturedMessage.body.length.toLocaleString()} characters${capturedMessage.bodyTruncated ? " (preview limit)" : ""}`;
    document.getElementById("link-count").textContent = `${capturedMessage.links.length}${capturedMessage.linksTruncated ? "+" : ""}`;
    messageSection.hidden = false;
    analyzeButton.hidden = false;
    setStatus("Message captured locally. Review it, then choose whether to analyze.", "ready");
  } catch {
    setStatus("Could not read this message. Refresh Gmail and try again.", "error");
  } finally {
    captureButton.disabled = false;
  }
});

function renderAssessment(result) {
  const validBands = ["low", "review", "high"];
  if (!validBands.includes(result?.band)
    || !["complete", "limited"].includes(result?.coverage)
    || !Array.isArray(result?.signals)
    || result.signals.some((signal) => typeof signal?.label !== "string"
      || (signal.probability !== undefined
        && (typeof signal.probability !== "number" || signal.probability < 0 || signal.probability > 1)))) {
    throw new Error("Invalid analysis response");
  }

  const band = document.getElementById("risk-band");
  const title = document.getElementById("assessment-title");
  const coverage = document.getElementById("coverage");
  const signalList = document.getElementById("signals");

  band.className = `risk-band ${result.band}`;
  band.textContent = result.band;
  title.textContent = {
    low: "No strong warning signals found",
    review: "Take a closer look",
    high: "Strong warning signals found"
  }[result.band];
  coverage.textContent = result.coverage === "limited"
    ? "The message capture was incomplete, so this assessment covers only the captured portion."
    : "This is a judgment about the captured content, not a guarantee that the email is safe.";
  signalList.replaceChildren();

  if (result.signals.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No individual warning signal crossed the display threshold.";
    signalList.append(item);
  } else {
    for (const signal of result.signals) {
      const item = document.createElement("li");
      item.textContent = signal.label;
      if (typeof signal.probability === "number") {
        const probability = document.createElement("span");
        probability.textContent = `Jev likelihood: ${Math.round(signal.probability * 100)}%`;
        item.append(probability);
      }
      signalList.append(item);
    }
  }

  assessmentSection.hidden = false;
}

analyzeButton.addEventListener("click", async () => {
  if (!capturedMessage) return;

  analyzeButton.disabled = true;
  assessmentSection.hidden = true;
  setStatus("Sending the captured message to Jev…");

  try {
    const response = await fetch(ANALYSIS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: capturedMessage })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result?.error || "analysis_failed");
    }

    renderAssessment(result);
    setStatus("Analysis complete.", result.band === "high" ? "error" : "ready");
  } catch {
    setStatus("Analysis is unavailable. Check that the local Jev service is running, then try again.", "error");
  } finally {
    analyzeButton.disabled = false;
  }
});

findGmailTab();
