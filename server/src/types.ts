export interface CapturedLink {
  text: string;
  href: string;
}

export interface CapturedMessage {
  subject: string;
  sender: {
    name: string;
    email: string;
  };
  body: string;
  bodyTruncated: boolean;
  links: CapturedLink[];
  linksTruncated: boolean;
}

export type RecipientRelation = "to_me" | "cc_me" | "not_listed" | "unclear";

export interface BatchCapturedMessage extends CapturedMessage {
  recipientRelation: RecipientRelation;
}

export type EmailPurpose =
  | "shopping_commercial"
  | "transactional"
  | "newsletter"
  | "personal_correspondence"
  | "work_or_service"
  | "other";

export interface RiskSignal {
  id: string;
  label: string;
  probability?: number;
}

export interface AnalysisResponse {
  band: "low" | "review" | "high";
  score: number;
  confidence: number;
  signals: RiskSignal[];
  coverage: "complete" | "limited";
  purpose: EmailPurpose;
  purposeConfidence: number;
  importanceProbability: number;
  likelyNeedsAttention: boolean;
}

export interface BatchAnalysisResult {
  index: number;
  result?: AnalysisResponse;
  error?: "analysis_failed" | "not_analyzed";
}
