import { TypeSafeClient, noul, score } from "@typesafe-ai/sdk";
import type { AnalysisResponse, CapturedMessage, RiskSignal } from "./types.js";

let client: TypeSafeClient | undefined;
const HIGH_PROBABILITY = 0.82;
const REVIEW_PROBABILITY = 0.56;
const HIGH_SCORE = 2.3;
const REVIEW_SCORE = 1.15;
const MIN_SCORE_CONFIDENCE = 0.55;

const questions = {
  sensitive_request: noul(
    "Does this message ask the recipient to provide or reveal a password, one-time verification code, payment detail, or account recovery information? Base the judgment on explicit requests in the message.",
    {
      true: "The message explicitly requests a credential, verification code, payment detail, or account recovery information.",
      false: "The message does not ask for one of those sensitive items."
    }
  ),
  identity_conflict: noul(
    "Does the message claim to represent an organization in a way that conflicts with the sender identity, message details, or linked destinations shown in the state? Do not infer a conflict only because a service uses a different sending domain.",
    {
      true: "There is a concrete mismatch between the claimed organization and the sender or linked destination.",
      false: "The available sender and message details do not show a concrete identity conflict."
    }
  ),
  deceptive_link: noul(
    "Does a link appear designed to mislead the recipient about its destination or purpose, based on the visible link text and the actual destination host?",
    {
      true: "Visible link text or surrounding context materially misrepresents the actual destination or purpose.",
      false: "The links do not show a clear attempt to misrepresent their destination or purpose."
    }
  ),
  coercive_pressure: noul(
    "Does the message use unusual urgency, secrecy, threats, or instructions to bypass normal verification to pressure the recipient into an action?",
    {
      true: "The message uses unusual pressure, secrecy, threats, or verification bypass instructions.",
      false: "The message does not show unusual coercive pressure."
    }
  ),
  concern: score(
    "Rate how strongly the captured email shows phishing or social engineering risk. Use only evidence in the state. Treat ordinary marketing urgency and generic third-party tracking links as weak evidence by themselves.",
    [
      "No meaningful signs of deception or unusual sensitive information requests are present.",
      "A minor oddity is present, but there is no concrete deceptive link, identity conflict, or unusual sensitive information request.",
      "There are meaningful warning signs, such as a suspicious identity claim paired with a sensitive request, a misleading link, or unusual pressure.",
      "There are strong and converging signs of phishing or social engineering, such as a deceptive identity or destination combined with credential or payment requests, urgency, or secrecy."
    ]
  )
} as const;

function getProbability(value: { type: string; noul?: number }, id: string): number {
  if (value.type !== "noul"
    || typeof value.noul !== "number"
    || !Number.isFinite(value.noul)
    || value.noul < 0
    || value.noul > 1) {
    throw new Error(`Unexpected Jev answer: ${id}`);
  }
  return value.noul;
}

function visibleHostname(text: string): string | undefined {
  const value = text.trim().replace(/[),.;]+$/, "");
  if (!value || /\s/.test(value)) return undefined;

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function normalizedHostname(href: string): string {
  return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
}

function hasVisibleHostMismatch(message: CapturedMessage): boolean {
  return message.links.some((link) => {
    const shownHost = visibleHostname(link.text);
    return shownHost !== undefined && shownHost !== normalizedHostname(link.href);
  });
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function analyzeMessage(message: CapturedMessage): Promise<AnalysisResponse> {
  const safeLinks = message.links.map((link) => {
    const url = new URL(link.href);
    return {
      text: link.text,
      destination: url.hostname
    };
  });
  const state = {
    email: {
      subject: message.subject,
      sender: message.sender,
      body: message.body,
      body_truncated: message.bodyTruncated,
      links_truncated: message.linksTruncated,
      links: safeLinks
    }
  };

  client ??= new TypeSafeClient();
  const response = await client.systemOne({
    model: "jev-latest",
    state,
    questions
  });

  const probabilities = {
    sensitiveRequest: getProbability(response.answers.sensitive_request, "sensitive_request"),
    identityConflict: getProbability(response.answers.identity_conflict, "identity_conflict"),
    deceptiveLink: getProbability(response.answers.deceptive_link, "deceptive_link"),
    coercivePressure: getProbability(response.answers.coercive_pressure, "coercive_pressure")
  };
  const concern = response.answers.concern;
  if (concern.type !== "score"
    || !Number.isFinite(concern.score)
    || concern.score < 0
    || concern.score > 3
    || !Number.isFinite(concern.confidence)
    || concern.confidence < 0
    || concern.confidence > 1) {
    throw new Error("Unexpected Jev score answer");
  }

  const signals: RiskSignal[] = [];
  const signalDefinitions = [
    ["sensitive_request", "The message asks for sensitive account or payment information.", probabilities.sensitiveRequest],
    ["identity_conflict", "The sender or linked destination conflicts with the identity claimed in the message.", probabilities.identityConflict],
    ["deceptive_link", "A link may misrepresent where it leads.", probabilities.deceptiveLink],
    ["coercive_pressure", "The message uses unusual pressure, secrecy, or instructions to bypass verification.", probabilities.coercivePressure]
  ] as const;

  for (const [id, label, probability] of signalDefinitions) {
    if (probability >= REVIEW_PROBABILITY) {
      signals.push({ id, label, probability: rounded(probability) });
    }
  }

  const hostMismatch = hasVisibleHostMismatch(message);
  if (hostMismatch) {
    signals.push({
      id: "visible_host_mismatch",
      label: "A link's visible domain differs from its actual destination."
    });
  }

  if (concern.confidence < MIN_SCORE_CONFIDENCE) {
    signals.push({ id: "uncertain_judgment", label: "Jev's overall judgment is uncertain; review the message manually." });
  }

  const maxNoul = Math.max(...Object.values(probabilities));
  const band: AnalysisResponse["band"] =
    concern.score >= HIGH_SCORE || maxNoul >= HIGH_PROBABILITY
      ? "high"
      : concern.score >= REVIEW_SCORE
        || maxNoul >= REVIEW_PROBABILITY
        || concern.confidence < MIN_SCORE_CONFIDENCE
        || hostMismatch
        || message.bodyTruncated
        || message.linksTruncated
        ? "review"
        : "low";

  return {
    band,
    score: rounded(concern.score),
    confidence: rounded(concern.confidence),
    signals,
    coverage: message.bodyTruncated || message.linksTruncated ? "limited" : "complete"
  };
}
