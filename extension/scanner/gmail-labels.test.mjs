import assert from "node:assert/strict";
import test from "node:test";
import {
  applySuggestedGmailLabels,
  buildLabelGroups,
  suggestedLabelNames
} from "./gmail-labels.mjs";

function analyzedRow(id, overrides = {}) {
  return {
    id,
    recipientRelation: "to_me",
    analysis: {
      purpose: "shopping_commercial",
      purposeConfidence: 0.9,
      likelyNeedsAttention: false,
      band: "low"
    },
    ...overrides
  };
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("suggests purpose, attention, recipient, and risk labels only from the matching evidence", () => {
  const row = analyzedRow("message-1", {
    recipientRelation: "not_listed",
    analysis: {
      purpose: "shopping_commercial",
      purposeConfidence: 0.9,
      likelyNeedsAttention: true,
      band: "review"
    }
  });

  assert.deepEqual(suggestedLabelNames(row), [
    "Inbox Signal - Shopping and Commercial",
    "Inbox Signal - Likely Important",
    "Inbox Signal - Not Listed in To-Cc",
    "Inbox Signal - Risk Review"
  ]);
});

test("omits a low-confidence purpose label and never labels unanalyzed or low-risk mail as risky", () => {
  const row = analyzedRow("message-2", {
    analysis: {
      purpose: "newsletter",
      purposeConfidence: 0.49,
      likelyNeedsAttention: false,
      band: "low"
    }
  });

  assert.deepEqual(suggestedLabelNames(row), []);
  assert.deepEqual(suggestedLabelNames({ ...row, analysis: null }), []);
  assert.deepEqual(suggestedLabelNames({ ...row, id: "" }), []);
});

test("groups only explicitly selected analyzed messages with identical label suggestions", () => {
  const rows = [
    analyzedRow("selected-1"),
    analyzedRow("selected-2"),
    analyzedRow("not-selected"),
    { id: "failed", analysisError: "analysis_failed" }
  ];

  assert.deepEqual(buildLabelGroups(rows, new Set(["selected-1", "selected-2", "failed"])), [
    {
      labelNames: ["Inbox Signal - Shopping and Commercial"],
      messageIds: ["selected-1", "selected-2"]
    }
  ]);
});

test("does not call Gmail at all when there are no selected label suggestions", async () => {
  let calls = 0;
  const outcome = await applySuggestedGmailLabels([analyzedRow("not-selected")], new Set(), "token", async () => {
    calls += 1;
    throw new Error("unexpected Gmail request");
  });

  assert.equal(calls, 0);
  assert.deepEqual(outcome, { appliedMessageIds: [], failedGroups: [], createdLabelNames: [] });
});

test("reuses existing labels, creates missing labels, and sends add-only batch requests", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body, authorization: options.headers.Authorization });

    if (url.endsWith("/labels") && options.method === "GET") {
      return jsonResponse({ labels: [{ id: "existing-id", name: "Inbox Signal - Shopping and Commercial" }] });
    }
    if (url.endsWith("/labels") && options.method === "POST") {
      return jsonResponse({ id: "created-id", name: body.name });
    }
    if (url.endsWith("/messages/batchModify")) return jsonResponse(null);
    throw new Error(`Unexpected Gmail request: ${url}`);
  };

  const row = analyzedRow("message-1", {
    recipientRelation: "not_listed",
    analysis: {
      purpose: "shopping_commercial",
      purposeConfidence: 0.9,
      likelyNeedsAttention: false,
      band: "low"
    }
  });
  const outcome = await applySuggestedGmailLabels([row], new Set([row.id]), "private-token", fetchImpl);
  const batchCall = calls.find((call) => call.url.endsWith("/messages/batchModify"));

  assert.equal(calls.length, 3);
  assert.deepEqual(outcome.appliedMessageIds, ["message-1"]);
  assert.equal(outcome.failedGroups.length, 0);
  assert.deepEqual(outcome.createdLabelNames, ["Inbox Signal - Not Listed in To-Cc"]);
  assert.deepEqual(batchCall.body, { ids: ["message-1"], addLabelIds: ["created-id", "existing-id"] });
  assert.equal(Object.hasOwn(batchCall.body, "removeLabelIds"), false);
  assert.equal(calls.every((call) => call.authorization === "Bearer private-token"), true);
});

test("does not modify messages when Gmail rejects label-list access", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    return { ok: false, status: 403 };
  };

  await assert.rejects(
    applySuggestedGmailLabels([analyzedRow("message-1")], new Set(["message-1"]), "token", fetchImpl),
    { code: "gmail_modify_access_denied" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endsWith("/labels"), true);
});

test("reports labels created before a later label-creation failure and does not update messages", async () => {
  const calls = [];
  let createCount = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/labels") && options.method === "GET") return jsonResponse({ labels: [] });
    if (url.endsWith("/labels") && options.method === "POST") {
      createCount += 1;
      if (createCount === 1) {
        const body = JSON.parse(options.body);
        return jsonResponse({ id: "created-id", name: body.name });
      }
      return { ok: false, status: 503 };
    }
    throw new Error("Message updates must not start until all labels exist");
  };
  const row = analyzedRow("message-1", {
    analysis: {
      purpose: "shopping_commercial",
      purposeConfidence: 0.9,
      likelyNeedsAttention: true,
      band: "review"
    }
  });

  await assert.rejects(
    applySuggestedGmailLabels([row], new Set([row.id]), "token", fetchImpl),
    (error) => error.code === "gmail_label_request_failed"
      && error.createdLabelNames[0] === "Inbox Signal - Likely Important"
  );
  assert.equal(calls.some((call) => call.url.endsWith("/messages/batchModify")), false);
});

test("reports successful and failed groups separately after a partial batch result", async () => {
  const calls = [];
  let modifyCount = 0;
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/labels") && options.method === "GET") {
      return jsonResponse({ labels: [
        { id: "shopping-id", name: "Inbox Signal - Shopping and Commercial" },
        { id: "important-id", name: "Inbox Signal - Likely Important" }
      ] });
    }
    if (url.endsWith("/labels") && options.method === "POST") {
      return jsonResponse({ id: "personal-id", name: body.name });
    }
    modifyCount += 1;
    if (modifyCount === 1) return jsonResponse(null);
    return { ok: false, status: 503 };
  };
  const rows = [
    analyzedRow("shopping"),
    analyzedRow("important", {
      analysis: {
        purpose: "personal_correspondence",
        purposeConfidence: 0.9,
        likelyNeedsAttention: true,
        band: "low"
      }
    })
  ];

  const outcome = await applySuggestedGmailLabels(rows, new Set(rows.map((row) => row.id)), "token", fetchImpl);

  assert.deepEqual(outcome.appliedMessageIds, ["shopping"]);
  assert.deepEqual(outcome.failedGroups, [{ messageIds: ["important"], code: "gmail_label_request_failed" }]);
  assert.equal(calls.filter((call) => call.url.endsWith("/messages/batchModify")).length, 2);
});
