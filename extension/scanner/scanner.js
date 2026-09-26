import {
  applySuggestedGmailLabels,
  INBOX_SIGNAL_LABEL_NAMES,
  suggestedLabelNames
} from "./gmail-labels.mjs";

const ANALYSIS_ENDPOINT = "http://127.0.0.1:8787/analyze-batch";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const MAX_MESSAGES = 20;
const MAX_BODY_LENGTH = 8_000;
const MAX_LINKS = 12;
const PURPOSE_LABELS = {
  shopping_commercial: "Shopping / commercial",
  transactional: "Transactional / account notice",
  newsletter: "Newsletter / digest",
  personal_correspondence: "Personal correspondence",
  work_or_service: "Work / service",
  other: "Other"
};
const RECIPIENT_LABELS = {
  to_me: "Listed in To",
  cc_me: "Listed in Cc",
  not_listed: "Not listed in To/Cc",
  unclear: "Recipient unclear"
};
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;

const scanButton = document.getElementById("scan");
const statusText = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const aliasesInput = document.getElementById("aliases");
const mailboxText = document.getElementById("mailbox");
const report = document.getElementById("report");
const results = document.getElementById("results");
const labelSelectionCount = document.getElementById("label-selection-count");
const labelActionStatus = document.getElementById("label-action-status");
const applyLabelsButton = document.getElementById("apply-labels");
const selectAllLabelsCheckbox = document.getElementById("select-all-labels");

let reportRows = [];
let selectedMessageIds = new Set();
let labelOperationInProgress = false;

function setStatus(text, state = "") {
  statusText.textContent = text;
  statusDot.className = `status-dot ${state}`.trim();
}

function normalizedAddress(value) {
  return value.trim().toLowerCase();
}

function findAddresses(value) {
  return [...new Set((value || "").match(EMAIL_PATTERN) || [])].map(normalizedAddress);
}

function readAliases() {
  return [...new Set((aliasesInput.value.match(EMAIL_PATTERN) || []).map(normalizedAddress))];
}

function headerValue(headers, name) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function recipientRelation(headers, ownedAddresses) {
  const toAddresses = findAddresses(headerValue(headers, "To"));
  const ccAddresses = findAddresses(headerValue(headers, "Cc"));
  if (toAddresses.some((address) => ownedAddresses.has(address))) return "to_me";
  if (ccAddresses.some((address) => ownedAddresses.has(address))) return "cc_me";
  return toAddresses.length || ccAddresses.length ? "not_listed" : "unclear";
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function collectBodyParts(part, found = { plain: [], html: [] }) {
  if (!part || part.filename) return found;
  if (part.body?.data) {
    try {
      const text = decodeBase64Url(part.body.data);
      if (part.mimeType === "text/plain") found.plain.push(text);
      if (part.mimeType === "text/html") found.html.push(text);
    } catch {
      // A malformed MIME part is skipped; the remaining message can still be reviewed.
    }
  }
  for (const child of part.parts || []) collectBodyParts(child, found);
  return found;
}

function linksFromHtml(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
  const links = [...parsed.querySelectorAll("a[href]")]
    .map((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) return null;
      try {
        const url = new URL(href);
        return {
          text: (anchor.textContent || "").trim().slice(0, 250),
          href: url.href
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { body: parsed.body?.textContent || "", links };
}

function linksFromPlainText(text) {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return matches.map((match) => {
    const href = match.replace(/[),.;!?]+$/, "");
    return { text: href.slice(0, 250), href };
  });
}

function parseSender(raw) {
  const email = findAddresses(raw)[0] || "";
  const name = raw
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*"|"\s*$/g, "")
    .trim();
  return { name: name || email || "Unknown sender", email };
}

function parseGmailMessage(message, ownedAddresses) {
  const headers = message.payload?.headers || [];
  const parts = collectBodyParts(message.payload);
  const htmlContent = parts.html[0] ? linksFromHtml(parts.html[0]) : null;
  const originalBody = parts.plain[0] || htmlContent?.body || "";
  const allLinks = htmlContent?.links.length ? htmlContent.links : linksFromPlainText(originalBody);
  const subject = headerValue(headers, "Subject").trim() || "(No subject)";
  const from = headerValue(headers, "From");
  const emailBody = originalBody.trim();
  const bodyUnavailable = emailBody.length === 0;
  const body = emailBody.slice(0, MAX_BODY_LENGTH);
  const internalDate = Number(message.internalDate);
  const date = Number.isFinite(internalDate) && internalDate > 0
    ? new Date(internalDate).toLocaleString()
    : "Date unavailable";

  return {
    id: message.id,
    date,
    subject,
    sender: parseSender(from),
    recipientRelation: recipientRelation(headers, ownedAddresses),
    body: body || "[No readable text body was found.]",
    bodyTruncated: bodyUnavailable || emailBody.length > MAX_BODY_LENGTH,
    links: allLinks.slice(0, MAX_LINKS),
    linksTruncated: allLinks.length > MAX_LINKS
  };
}

async function getAccessToken(scopes) {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id || "";
  if (clientId.startsWith("REPLACE_WITH_")) throw new Error("oauth_not_configured");
  let auth;
  try {
    const options = { interactive: true };
    if (Array.isArray(scopes)) options.scopes = scopes;
    auth = await chrome.identity.getAuthToken(options);
  } catch {
    throw new Error("google_auth_failed");
  }
  if (!auth?.token) throw new Error("google_auth_failed");
  if (Array.isArray(auth.grantedScopes) && Array.isArray(scopes)
    && scopes.some((scope) => !auth.grantedScopes.includes(scope))) {
    throw new Error("gmail_scope_not_granted");
  }
  return auth.token;
}

async function gmailRequest(path, token) {
  let response;
  try {
    response = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    throw new Error("gmail_network_error");
  }

  if (response.status === 401) throw new Error("google_auth_expired");
  if (response.status === 403) throw new Error("gmail_access_denied");
  if (!response.ok) throw new Error("gmail_request_failed");
  return response.json();
}

async function mapWithConcurrency(items, limit, mapper, progressLabel = "Reading message") {
  const output = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        output[index] = await mapper(items[index], index);
      } catch {
        output[index] = { id: items[index].id, fetchError: true };
      }
      completed += 1;
      setStatus(`${progressLabel} ${completed} of ${items.length}…`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

async function getInboxSignalLabelIds(token) {
  const payload = await gmailRequest("/labels", token);
  if (!Array.isArray(payload?.labels)) throw new Error("gmail_labels_unavailable");

  const signalNames = new Set(INBOX_SIGNAL_LABEL_NAMES);
  return new Set(payload.labels
    .filter((label) => signalNames.has(label?.name) && typeof label?.id === "string")
    .map((label) => label.id));
}

async function listEligibleInboxMessages(token, ownedAddresses, inboxSignalLabelIds) {
  const rows = [];
  let pageToken;

  while (rows.length < MAX_MESSAGES) {
    const query = new URLSearchParams({
      labelIds: "INBOX",
      maxResults: String(MAX_MESSAGES)
    });
    if (pageToken) query.set("pageToken", pageToken);

    const list = await gmailRequest(`/messages?${query.toString()}`, token);
    const references = list.messages || [];
    if (references.length === 0) break;

    const uniqueThreads = [...new Map(references.map((reference) => {
      const key = reference.threadId
        ? `thread:${reference.threadId}`
        : `message:${reference.id}`;
      return [key, { id: key, reference }];
    })).values()];
    const labelChecks = await mapWithConcurrency(uniqueThreads, 4, async ({ id, reference }) => {
      if (reference.threadId) {
        const thread = await gmailRequest(
          `/threads/${encodeURIComponent(reference.threadId)}?format=minimal`,
          token
        );
        if (!Array.isArray(thread.messages)) throw new Error("gmail_thread_metadata_unavailable");
        return {
          id,
          alreadyCategorised: thread.messages.some((message) =>
            message.labelIds?.some((labelId) => inboxSignalLabelIds.has(labelId))
          )
        };
      }

      const message = await gmailRequest(
        `/messages/${encodeURIComponent(reference.id)}?format=minimal`,
        token
      );
      return {
        id,
        alreadyCategorised: message.labelIds?.some((labelId) => inboxSignalLabelIds.has(labelId)) || false
      };
    }, "Checking Inbox labels");
    const labelStateByThread = new Map(labelChecks.map((check) => [check?.id, check]));
    const candidates = references.map((reference) => {
      const key = reference.threadId
        ? `thread:${reference.threadId}`
        : `message:${reference.id}`;
      return { reference, labelState: labelStateByThread.get(key) };
    }).filter(({ labelState }) => !labelState?.alreadyCategorised);

    let candidateIndex = 0;
    while (candidateIndex < candidates.length && rows.length < MAX_MESSAGES) {
      const page = candidates.slice(candidateIndex, candidateIndex + (MAX_MESSAGES - rows.length));
      const readableCandidates = page
        .filter(({ labelState }) => !labelState?.fetchError)
        .map(({ reference }) => reference);
      const messageRows = await mapWithConcurrency(readableCandidates, 4, async (reference) => {
        const message = await gmailRequest(
          `/messages/${encodeURIComponent(reference.id)}?format=full`,
          token
        );
        return parseGmailMessage(message, ownedAddresses);
      }, "Reading eligible message");
      const messageRowById = new Map(messageRows.map((row) => [row.id, row]));
      for (const { reference, labelState } of page) {
        rows.push(labelState?.fetchError
          ? { id: reference.id, fetchError: true }
          : messageRowById.get(reference.id));
      }
      candidateIndex += page.length;
    }

    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  return rows;
}

function createStat(label, value, detail) {
  const card = document.createElement("div");
  card.className = "stat-card";
  const large = document.createElement("strong");
  large.className = "stat-value";
  large.textContent = value;
  const name = document.createElement("span");
  name.className = "stat-label";
  name.textContent = label;
  const note = document.createElement("span");
  note.className = "stat-detail";
  note.textContent = detail;
  card.append(large, name, note);
  return card;
}

function renderBreakdown(list, labels, countFor, total) {
  list.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const count = countFor(key);
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("strong");
    value.textContent = `${count} · ${total ? Math.round((count / total) * 100) : 0}%`;
    row.append(name, value);
    list.append(row);
  }
}

function appendTag(parent, label, className = "") {
  const tag = document.createElement("span");
  tag.className = `tag ${className}`.trim();
  tag.textContent = label;
  parent.append(tag);
}

function renderLabelProposal(row, rowIndex) {
  const proposal = document.createElement("div");
  proposal.className = "label-proposal";
  const choice = document.createElement("label");
  choice.className = "label-choice";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = `label-message-${rowIndex}`;
  checkbox.checked = selectedMessageIds.has(row.id);
  checkbox.disabled = labelOperationInProgress || row.labelStatus === "applied";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedMessageIds.add(row.id);
    else selectedMessageIds.delete(row.id);
    updateLabelControls();
  });
  const choiceText = document.createElement("span");
  choiceText.textContent = `Select this message · ${row.labelSuggestions.length} suggested label${row.labelSuggestions.length === 1 ? "" : "s"}`;
  choice.append(checkbox, choiceText);
  proposal.append(choice);

  const suggestions = document.createElement("div");
  suggestions.className = "suggested-labels";
  for (const name of row.labelSuggestions) appendTag(suggestions, name, "suggested");
  proposal.append(suggestions);

  const actionResult = document.createElement("p");
  actionResult.className = `label-result-status ${row.labelStatus === "failed" ? "error" : ""}`.trim();
  actionResult.dataset.labelStatusFor = row.id;
  actionResult.textContent = row.labelStatus === "applied"
    ? "Labels applied to this message."
    : row.labelStatus === "failed"
      ? formatLabelError({ code: row.labelError })
      : "";
  proposal.append(actionResult);
  return proposal;
}

function renderEmailRow(row, rowIndex) {
  const article = document.createElement("article");
  article.className = `email-row ${row.analysis ? "" : "failed"}`.trim();
  if (row.id) article.dataset.messageId = row.id;
  const top = document.createElement("div");
  top.className = "email-top";
  const title = document.createElement("div");
  title.className = "email-title";
  const subject = document.createElement("h4");
  subject.textContent = row.subject || "Message details unavailable";
  const sender = document.createElement("p");
  sender.textContent = row.sender?.email
    ? `${row.sender.name} <${row.sender.email}>`
    : (row.sender?.name || "Sender unavailable");
  const date = document.createElement("span");
  date.className = "email-date";
  date.textContent = row.date || "";
  title.append(subject, sender);
  top.append(title, date);
  article.append(top);

  if (row.analysis) {
    const tags = document.createElement("div");
    tags.className = "tags";
    appendTag(tags, PURPOSE_LABELS[row.analysis.purpose] || "Other");
    appendTag(tags, RECIPIENT_LABELS[row.recipientRelation] || RECIPIENT_LABELS.unclear);
    appendTag(tags, `Risk: ${row.analysis.band}`, row.analysis.band);
    if (row.analysis.purposeConfidence < 0.5) appendTag(tags, "Purpose unclear", "uncertain");
    article.append(tags);

    const summary = document.createElement("p");
    summary.className = "email-summary";
    summary.textContent = `Jev risk-score confidence: ${Math.round(row.analysis.confidence * 100)}% (manual review below 55%). Needs-attention likelihood: ${Math.round(row.analysis.importanceProbability * 100)}% ("likely" at 70% or above). `;
    const assessment = document.createElement("strong");
    assessment.textContent = row.analysis.likelyNeedsAttention ? "Likely needs attention." : "No clear action identified.";
    summary.append(assessment);
    if (row.analysis.coverage === "limited") summary.append(" The text body was unavailable or the analyzed text or links were truncated.");
    article.append(summary);

    if (row.analysis.signals.length) {
      const signals = document.createElement("ul");
      signals.className = "signals";
      for (const signal of row.analysis.signals) {
        const item = document.createElement("li");
        item.textContent = signal.label;
        signals.append(item);
      }
      article.append(signals);
    }
  } else {
    const problem = document.createElement("p");
    problem.className = "row-error";
    problem.textContent = row.fetchError
      ? "Gmail could not provide this message's details during the scan."
      : row.analysisError === "not_analyzed"
        ? "Jev did not analyze this message; the batch may have stopped after a service or API-key error."
        : "Jev analysis failed for this message. You can retry the scan.";
    article.append(problem);
  }

  if (row.analysis && row.labelSuggestions?.length) {
    article.append(renderLabelProposal(row, rowIndex));
  }

  if (row.id) {
    const open = document.createElement("a");
    open.className = "email-link";
    open.href = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(row.id)}`;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open in Gmail ↗";
    article.append(open);
  }
  return article;
}

function renderReport(rows, listedCount) {
  reportRows = rows;
  selectedMessageIds.clear();
  for (const row of reportRows) row.labelSuggestions = suggestedLabelNames(row);

  const analyzed = rows.filter((row) => row.analysis);
  const total = analyzed.length;
  const attention = analyzed.filter((row) => row.analysis.likelyNeedsAttention).length;
  const direct = analyzed.filter((row) => row.recipientRelation === "to_me" || row.recipientRelation === "cc_me").length;
  const directAndAttention = analyzed.filter((row) =>
    (row.recipientRelation === "to_me" || row.recipientRelation === "cc_me")
      && row.analysis.likelyNeedsAttention
  ).length;
  const riskReview = analyzed.filter((row) => row.analysis.band !== "low").length;

  document.getElementById("report-count").textContent = `${total} of ${listedCount} analyzed`;
  const failedCount = rows.length - total;
  document.getElementById("report-note").textContent = total
    ? `${total} analyzed successfully. Percentages and category counts use these Jev-analyzed messages only${failedCount ? `; ${failedCount} message${failedCount === 1 ? " was" : "s were"} unavailable or not analyzed` : ""}. The 70% attention threshold is a provisional display rule, not a validated measure of correctness.`
    : "No messages received Jev results, so no percentages are shown. Check Gmail authorization, the local relay, and the Jev API key.";

  const statGrid = document.getElementById("stat-grid");
  statGrid.replaceChildren(
    createStat("Needs attention", total ? `${Math.round((attention / total) * 100)}%` : "—", `${attention} of ${total} Jev-analyzed messages at or above the provisional 70% threshold`),
    createStat("Listed in To or Cc", total ? `${Math.round((direct / total) * 100)}%` : "—", `${direct} of ${total} analyzed messages list you or an alias in To/Cc`),
    createStat("Direct + attention", total ? `${Math.round((directAndAttention / total) * 100)}%` : "—", `${directAndAttention} messages both list you in To/Cc and likely need attention`),
    createStat("Risk: review or high", total ? `${Math.round((riskReview / total) * 100)}%` : "—", `${riskReview} messages have one or more signals worth a closer look`)
  );

  renderBreakdown(
    document.getElementById("purpose-breakdown"),
    PURPOSE_LABELS,
    (purpose) => analyzed.filter((row) => row.analysis.purpose === purpose).length,
    total
  );
  renderBreakdown(
    document.getElementById("recipient-breakdown"),
    RECIPIENT_LABELS,
    (relation) => analyzed.filter((row) => row.recipientRelation === relation).length,
    total
  );

  labelActionStatus.textContent = total
    ? "No labels have been applied. Select analyzed messages below to review and apply their suggestions."
    : "No labels can be suggested until a message is analyzed.";
  labelActionStatus.classList.remove("error");
  results.replaceChildren(...rows.map(renderEmailRow));
  updateLabelControls();
  report.hidden = false;
}

function rowsAvailableForLabeling() {
  return reportRows.filter((row) => row.id
    && row.labelSuggestions?.length
    && row.labelStatus !== "applied");
}

function selectedRowsForLabeling() {
  return rowsAvailableForLabeling().filter((row) => selectedMessageIds.has(row.id));
}

function updateLabelControls() {
  const availableRows = rowsAvailableForLabeling();
  const selectedRows = selectedRowsForLabeling();
  const suggestedCount = selectedRows.reduce((count, row) => count + row.labelSuggestions.length, 0);
  labelSelectionCount.textContent = availableRows.length
    ? selectedRows.length
      ? `${selectedRows.length} of ${availableRows.length} eligible message${availableRows.length === 1 ? "" : "s"} selected · ${suggestedCount} label${suggestedCount === 1 ? "" : "s"} will be added`
      : `${availableRows.length} message${availableRows.length === 1 ? " has" : "s have"} suggested labels; none selected.`
    : "No unapplied messages with suggested labels.";
  applyLabelsButton.disabled = labelOperationInProgress || selectedRows.length === 0;
  selectAllLabelsCheckbox.disabled = labelOperationInProgress || availableRows.length === 0;
  selectAllLabelsCheckbox.checked = availableRows.length > 0 && selectedRows.length === availableRows.length;
  selectAllLabelsCheckbox.indeterminate = selectedRows.length > 0 && selectedRows.length < availableRows.length;

  for (const checkbox of results.querySelectorAll(".label-choice input")) {
    const row = reportRows.find((candidate) => candidate.id === checkbox.closest("article")?.dataset.messageId);
    checkbox.disabled = labelOperationInProgress || row?.labelStatus === "applied";
  }
}

selectAllLabelsCheckbox.addEventListener("change", () => {
  const availableRows = rowsAvailableForLabeling();
  for (const row of availableRows) {
    if (selectAllLabelsCheckbox.checked) selectedMessageIds.add(row.id);
    else selectedMessageIds.delete(row.id);
  }
  for (const checkbox of results.querySelectorAll(".label-choice input")) {
    const row = reportRows.find((candidate) => candidate.id === checkbox.closest("article")?.dataset.messageId);
    if (row) checkbox.checked = selectedMessageIds.has(row.id);
  }
  updateLabelControls();
});

function formatLabelError(error) {
  switch (error?.code || error?.message) {
    case "google_auth_failed":
      return "Google authorization did not complete. Click Apply again and approve the Gmail access request.";
    case "google_auth_expired":
      return "Google rejected the access token. Click Apply again to request fresh authorization.";
    case "gmail_modify_access_denied":
      return "Google denied label editing. Confirm gmail.modify is configured in Google Auth Platform and approved for this account.";
    case "gmail_scope_not_granted":
      return "Gmail label permission was not granted. Click Apply again and approve the additional Gmail access request.";
    case "gmail_label_network_error":
      return "Could not reach Gmail to apply labels. Check your connection and retry.";
    case "gmail_label_response_invalid":
      return "Gmail returned an unexpected label response. No further labels were applied.";
    default:
      return "Gmail could not apply some labels. Check the affected rows and retry if needed.";
  }
}

function syncLabelRowStatus(row) {
  const article = [...results.querySelectorAll(".email-row[data-message-id]")]
    .find((candidate) => candidate.dataset.messageId === row.id);
  if (!article) return;
  const checkbox = article.querySelector(".label-choice input");
  const status = article.querySelector(".label-result-status");
  if (checkbox) {
    checkbox.checked = selectedMessageIds.has(row.id);
    checkbox.disabled = labelOperationInProgress || row.labelStatus === "applied";
  }
  if (status) {
    status.classList.toggle("error", row.labelStatus === "failed");
    status.textContent = row.labelStatus === "applied"
      ? "Labels applied to this message."
      : row.labelStatus === "failed"
        ? formatLabelError({ code: row.labelError })
        : "";
  }
}

function applyLabelOutcomesToRows(outcome) {
  for (const id of outcome.appliedMessageIds) {
    const row = reportRows.find((candidate) => candidate.id === id);
    if (!row) continue;
    row.labelStatus = "applied";
    row.labelError = null;
    selectedMessageIds.delete(id);
    syncLabelRowStatus(row);
  }
  for (const group of outcome.failedGroups) {
    for (const id of group.messageIds) {
      const row = reportRows.find((candidate) => candidate.id === id);
      if (!row) continue;
      row.labelStatus = "failed";
      row.labelError = group.code;
      selectedMessageIds.add(id);
      syncLabelRowStatus(row);
    }
  }
}

function labelOutcomeMessage(outcome) {
  const appliedCount = outcome.appliedMessageIds.length;
  const failedCount = outcome.failedGroups.reduce((count, group) => count + group.messageIds.length, 0);
  const createdCount = outcome.createdLabelNames.length;
  const createdNote = createdCount ? ` Created ${createdCount} missing label${createdCount === 1 ? "" : "s"}.` : "";
  return {
    failed: failedCount > 0,
    text: failedCount
      ? `${appliedCount} message${appliedCount === 1 ? "" : "s"} updated; ${failedCount} could not be labeled.${createdNote} Failed messages remain selected so you can retry.`
      : `Labels applied to ${appliedCount} message${appliedCount === 1 ? "" : "s"}.${createdNote}`
  };
}

async function applySelectedLabels() {
  if (labelOperationInProgress) return;
  const selectedRows = selectedRowsForLabeling();
  if (selectedRows.length === 0) return;

  labelOperationInProgress = true;
  scanButton.disabled = true;
  labelActionStatus.classList.remove("error");
  labelActionStatus.textContent = "Requesting Google authorization, then creating any missing labels…";
  updateLabelControls();

  try {
    const token = await getAccessToken([GMAIL_MODIFY_SCOPE]);
    const outcome = await applySuggestedGmailLabels(
      reportRows,
      new Set(selectedRows.map((row) => row.id)),
      token
    );
    applyLabelOutcomesToRows(outcome);
    const status = labelOutcomeMessage(outcome);
    labelActionStatus.classList.toggle("error", status.failed);
    labelActionStatus.textContent = status.text;
  } catch (error) {
    labelActionStatus.classList.add("error");
    const createdCount = Array.isArray(error?.createdLabelNames) ? error.createdLabelNames.length : 0;
    const createdNote = createdCount
      ? ` ${createdCount} label${createdCount === 1 ? " was" : "s were"} created, but no message-label update was completed.`
      : "";
    labelActionStatus.textContent = `${formatLabelError(error)}${createdNote}`;
  } finally {
    labelOperationInProgress = false;
    scanButton.disabled = false;
    updateLabelControls();
  }
}

function formatScanError(error) {
  switch (error?.message) {
    case "oauth_not_configured":
      return "Set up the Google OAuth client ID in extension/manifest.json, then reload the extension.";
    case "google_auth_failed":
      return "Google sign-in did not complete. Try again and approve the requested Gmail access.";
    case "google_auth_expired":
      return "Google's access token was rejected. Try scanning again to refresh authorization.";
    case "gmail_access_denied":
      return "Gmail access was denied. Confirm the Gmail API is enabled, gmail.readonly is configured, and this account approved access.";
    case "gmail_labels_unavailable":
      return "Inbox Signal couldn't check Gmail labels. Confirm read-only Gmail access and retry.";
    case "gmail_network_error":
    case "gmail_request_failed":
      return "Could not retrieve the Gmail messages. Check your connection and retry.";
    default:
      return "The scan could not start. Check the setup steps and retry.";
  }
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  report.hidden = true;
  mailboxText.textContent = "Connecting…";
  let rows = [];
  let listedCount = 0;

  try {
    const aliases = readAliases();
    setStatus("Requesting read-only Gmail access…");
    const token = await getAccessToken();
    await chrome.storage.local.set({ recipientAliases: aliases });

    setStatus("Finding the newest uncategorised Inbox messages…");
    const [profile, inboxSignalLabelIds] = await Promise.all([
      gmailRequest("/profile", token),
      getInboxSignalLabelIds(token)
    ]);
    const primaryAddress = normalizedAddress(profile.emailAddress || "");
    if (!primaryAddress) throw new Error("gmail_profile_unavailable");
    mailboxText.textContent = primaryAddress;
    const ownedAddresses = new Set([primaryAddress, ...aliases]);
    rows = await listEligibleInboxMessages(token, ownedAddresses, inboxSignalLabelIds);
    listedCount = rows.length;

    if (rows.length === 0) {
      renderReport(rows, 0);
      setStatus("No uncategorised Inbox messages are ready to review.", "ready");
      return;
    }

    const submitted = [];
    rows.forEach((row, rowIndex) => {
      if (!row.fetchError) {
        submitted.push({ rowIndex, message: {
          subject: row.subject,
          sender: row.sender,
          body: row.body,
          bodyTruncated: row.bodyTruncated,
          links: row.links,
          linksTruncated: row.linksTruncated,
          recipientRelation: row.recipientRelation
        } });
      }
    });

    if (submitted.length) {
      setStatus(`Sending ${submitted.length} message${submitted.length === 1 ? "" : "s"} to the local relay for Jev analysis…`);
      let payload;
      try {
        const response = await fetch(ANALYSIS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: submitted.map((item) => item.message) })
        });
        if (response.status === 429) throw new Error("relay_rate_limited");
        if (!response.ok) throw new Error("relay_failed");
        payload = await response.json();
      } catch (error) {
        if (error?.message === "relay_rate_limited") throw error;
        throw new Error("relay_failed");
      }
      if (!Array.isArray(payload?.results)) throw new Error("relay_failed");

      for (const item of payload.results) {
        const submittedItem = submitted[item?.index];
        if (!submittedItem) continue;
        if (item.result && isAnalysisResponse(item.result)) rows[submittedItem.rowIndex].analysis = item.result;
        else rows[submittedItem.rowIndex].analysisError = item.error === "not_analyzed" ? "not_analyzed" : "analysis_failed";
      }
    }

    renderReport(rows, listedCount);
    const analyzedCount = rows.filter((row) => row.analysis).length;
    if (analyzedCount === listedCount) {
      setStatus(`Review complete: ${analyzedCount} message${analyzedCount === 1 ? "" : "s"} analyzed.`, "ready");
    } else {
      setStatus(`${analyzedCount} of ${listedCount} messages analyzed; see unavailable rows below.`, "error");
    }
  } catch (error) {
    if (rows.length) renderReport(rows, listedCount);
    if (error?.message === "gmail_profile_unavailable") {
      mailboxText.textContent = "Account unavailable";
      setStatus("Could not identify the Gmail mailbox for this authorization. Check the selected Google account.", "error");
    } else if (error?.message === "relay_rate_limited") {
      setStatus("The local relay's analysis limit was reached. Wait a minute, then retry.", "error");
    } else if (error?.message === "relay_failed") {
      setStatus("Jev analysis is unavailable. Check that the local relay is running and your Jev API key is configured.", "error");
    } else {
      setStatus(formatScanError(error), "error");
    }
  } finally {
    scanButton.disabled = false;
  }
});

applyLabelsButton.addEventListener("click", applySelectedLabels);

function isAnalysisResponse(result) {
  const purposeIds = Object.keys(PURPOSE_LABELS);
  return ["low", "review", "high"].includes(result?.band)
    && ["complete", "limited"].includes(result?.coverage)
    && purposeIds.includes(result?.purpose)
    && typeof result?.purposeConfidence === "number"
    && result.purposeConfidence >= 0
    && result.purposeConfidence <= 1
    && typeof result?.importanceProbability === "number"
    && result.importanceProbability >= 0
    && result.importanceProbability <= 1
    && typeof result?.likelyNeedsAttention === "boolean"
    && Array.isArray(result?.signals)
    && result.signals.every((signal) => typeof signal?.label === "string");
}

chrome.storage.local.get("recipientAliases").then((values) => {
  if (Array.isArray(values.recipientAliases)) aliasesInput.value = values.recipientAliases.join("\n");
}).catch(() => {});
