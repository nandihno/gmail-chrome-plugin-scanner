const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PURPOSE_LABELS = Object.freeze({
  shopping_commercial: "Inbox Signal - Shopping and Commercial",
  transactional: "Inbox Signal - Transactional and Account Notices",
  newsletter: "Inbox Signal - Newsletters and Digests",
  personal_correspondence: "Inbox Signal - Personal Correspondence",
  work_or_service: "Inbox Signal - Work and Services",
  other: "Inbox Signal - Other"
});

const ATTENTION_LABEL = "Inbox Signal - Likely Important";
const RECIPIENT_LABEL = "Inbox Signal - Not Listed in To-Cc";
const RISK_LABEL = "Inbox Signal - Risk Review";
const MISDIRECTED_LABEL = "Inbox Signal - Misdirected / Other Person";
export const INBOX_SIGNAL_LABEL_NAMES = Object.freeze([
  ...Object.values(PURPOSE_LABELS),
  ATTENTION_LABEL,
  RECIPIENT_LABEL,
  RISK_LABEL,
  MISDIRECTED_LABEL
]);

export const LABEL_TYPE_DEFINITIONS = Object.freeze([
  {
    name: PURPOSE_LABELS.shopping_commercial,
    code: "PURPOSE::SHOPPING",
    shortLabel: "Shopping & Commercial",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: PURPOSE_LABELS.transactional,
    code: "PURPOSE::TRANSACTIONAL",
    shortLabel: "Transactional & Account",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: PURPOSE_LABELS.newsletter,
    code: "PURPOSE::NEWSLETTER",
    shortLabel: "Newsletters & Digests",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: PURPOSE_LABELS.personal_correspondence,
    code: "PURPOSE::PERSONAL",
    shortLabel: "Personal Correspondence",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: PURPOSE_LABELS.work_or_service,
    code: "PURPOSE::WORK_SERVICE",
    shortLabel: "Work & Services",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: PURPOSE_LABELS.other,
    code: "PURPOSE::OTHER",
    shortLabel: "Other Purpose",
    category: "purpose",
    tone: "cyan"
  },
  {
    name: ATTENTION_LABEL,
    code: "TRIAGE::IMPORTANT",
    shortLabel: "Likely Important",
    category: "triage",
    tone: "green"
  },
  {
    name: RECIPIENT_LABEL,
    code: "HEADER::NOT_IN_TO_CC",
    shortLabel: "Not Listed in To/Cc",
    category: "triage",
    tone: "amber"
  },
  {
    name: RISK_LABEL,
    code: "SECURITY::RISK_REVIEW",
    shortLabel: "Risk Review",
    category: "triage",
    tone: "red"
  },
  {
    name: MISDIRECTED_LABEL,
    code: "ALERT::MISDIRECTED",
    shortLabel: "Misdirected / Other Person",
    category: "triage",
    tone: "magenta"
  }
]);

export class GmailLabelError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "GmailLabelError";
    this.code = code;
    this.status = status;
  }
}

function errorForStatus(status) {
  if (status === 401) return new GmailLabelError("google_auth_expired", status);
  if (status === 403) return new GmailLabelError("gmail_modify_access_denied", status);
  return new GmailLabelError("gmail_label_request_failed", status);
}

async function apiRequest(fetchImpl, path, token, options = {}) {
  let response;
  try {
    response = await fetchImpl(`${GMAIL_API}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
  } catch {
    throw new GmailLabelError("gmail_label_network_error");
  }

  if (!response.ok && !options.acceptStatuses?.includes(response.status)) {
    throw errorForStatus(response.status);
  }
  return response;
}

async function loadLabels(fetchImpl, token) {
  const response = await apiRequest(fetchImpl, "/labels", token);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GmailLabelError("gmail_label_response_invalid");
  }
  if (!Array.isArray(payload?.labels)) {
    throw new GmailLabelError("gmail_label_response_invalid");
  }

  return new Map(payload.labels
    .filter((label) => typeof label?.name === "string" && typeof label?.id === "string")
    .map((label) => [label.name, label]));
}

export function suggestedLabelNames(row) {
  if (!row?.id || !row.analysis) return [];

  const labels = [];
  const purposeLabel = PURPOSE_LABELS[row.analysis.purpose];
  if (purposeLabel && Number.isFinite(row.analysis.purposeConfidence) && row.analysis.purposeConfidence >= 0.5) {
    labels.push(purposeLabel);
  }
  if (row.analysis.likelyMisdirected === true) {
    labels.push(MISDIRECTED_LABEL);
  } else if (row.analysis.likelyNeedsAttention === true) {
    labels.push(ATTENTION_LABEL);
  }
  if (row.recipientRelation === "not_listed") labels.push(RECIPIENT_LABEL);
  if (["review", "high"].includes(row.analysis.band)) labels.push(RISK_LABEL);
  return [...new Set(labels)];
}

export function buildLabelGroups(rows, selectedMessageIds) {
  if (!Array.isArray(rows) || !(selectedMessageIds instanceof Set) || selectedMessageIds.size === 0) {
    return [];
  }

  const grouped = new Map();
  for (const row of rows) {
    if (!row?.id || !selectedMessageIds.has(row.id)) continue;
    const labelNames = suggestedLabelNames(row).sort();
    if (labelNames.length === 0) continue;

    const key = JSON.stringify(labelNames);
    if (!grouped.has(key)) grouped.set(key, { labelNames, messageIds: [] });
    const group = grouped.get(key);
    if (!group.messageIds.includes(row.id)) group.messageIds.push(row.id);
  }

  return [...grouped.values()];
}

async function ensureLabels(fetchImpl, token, requiredNames) {
  const labelsByName = await loadLabels(fetchImpl, token);
  const createdLabelNames = [];

  try {
    for (const name of requiredNames) {
      if (labelsByName.has(name)) continue;

      const response = await apiRequest(fetchImpl, "/labels", token, {
        method: "POST",
        body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
        acceptStatuses: [409]
      });

      if (response.status === 409) {
        const refreshedLabels = await loadLabels(fetchImpl, token);
        const racedLabel = refreshedLabels.get(name);
        if (!racedLabel) throw new GmailLabelError("gmail_label_request_failed", 409);
        labelsByName.set(name, racedLabel);
        continue;
      }

      let created;
      try {
        created = await response.json();
      } catch {
        throw new GmailLabelError("gmail_label_response_invalid");
      }
      if (created?.name !== name || typeof created?.id !== "string") {
        throw new GmailLabelError("gmail_label_response_invalid");
      }
      labelsByName.set(name, created);
      createdLabelNames.push(name);
    }
  } catch (error) {
    if (error instanceof GmailLabelError && createdLabelNames.length) {
      error.createdLabelNames = createdLabelNames.slice();
    }
    throw error;
  }

  return { labelsByName, createdLabelNames };
}

async function applyLabelGroups(groups, labelsByName, fetchImpl, token) {
  const appliedMessageIds = [];
  const failedGroups = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const addLabelIds = group.labelNames.map((name) => labelsByName.get(name)?.id);
    if (addLabelIds.some((id) => typeof id !== "string")) {
      throw new GmailLabelError("gmail_label_response_invalid");
    }

    try {
      await apiRequest(fetchImpl, "/messages/batchModify", token, {
        method: "POST",
        body: { ids: group.messageIds, addLabelIds }
      });
      appliedMessageIds.push(...group.messageIds);
    } catch (error) {
      const code = error instanceof GmailLabelError ? error.code : "gmail_label_request_failed";
      for (const failedGroup of groups.slice(index)) {
        failedGroups.push({ messageIds: failedGroup.messageIds, code });
      }
      break;
    }
  }

  return { appliedMessageIds, failedGroups };
}

export function summarizeLabelsByType(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const analyzedRows = safeRows.filter((row) => row?.analysis);
  const analyzedCount = analyzedRows.length;

  const countsByName = new Map(LABEL_TYPE_DEFINITIONS.map((def) => [def.name, 0]));
  const appliedByName = new Map(LABEL_TYPE_DEFINITIONS.map((def) => [def.name, 0]));

  for (const row of analyzedRows) {
    const labels = Array.isArray(row.labelSuggestions)
      ? row.labelSuggestions
      : suggestedLabelNames(row);
    for (const label of labels) {
      if (countsByName.has(label)) {
        countsByName.set(label, countsByName.get(label) + 1);
        if (row.labelStatus === "applied") {
          appliedByName.set(label, appliedByName.get(label) + 1);
        }
      }
    }
  }

  let totalSuggestedLabels = 0;
  for (const count of countsByName.values()) totalSuggestedLabels += count;

  const items = LABEL_TYPE_DEFINITIONS.map((def) => {
    const count = countsByName.get(def.name) || 0;
    const appliedCount = appliedByName.get(def.name) || 0;
    return {
      ...def,
      count,
      appliedCount,
      shareOfMessages: analyzedCount ? Math.round((count / analyzedCount) * 100) : 0,
      shareOfLabels: totalSuggestedLabels ? Math.round((count / totalSuggestedLabels) * 100) : 0
    };
  });

  const purposeCount = items
    .filter((item) => item.category === "purpose")
    .reduce((sum, item) => sum + item.count, 0);
  const triageCount = items
    .filter((item) => item.category === "triage")
    .reduce((sum, item) => sum + item.count, 0);

  return {
    analyzedCount,
    totalSuggestedLabels,
    purposeCount,
    triageCount,
    items
  };
}

export async function applySuggestedGmailLabels(rows, selectedMessageIds, token, fetchImpl = globalThis.fetch) {
  const groups = buildLabelGroups(rows, selectedMessageIds);
  if (groups.length === 0) {
    return { appliedMessageIds: [], failedGroups: [], createdLabelNames: [] };
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new GmailLabelError("google_auth_failed");
  }

  const requiredNames = [...new Set(groups.flatMap((group) => group.labelNames))].sort();
  const { labelsByName, createdLabelNames } = await ensureLabels(fetchImpl, token, requiredNames);
  const { appliedMessageIds, failedGroups } = await applyLabelGroups(groups, labelsByName, fetchImpl, token);
  return { appliedMessageIds, failedGroups, createdLabelNames };
}
