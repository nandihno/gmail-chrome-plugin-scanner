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
}
