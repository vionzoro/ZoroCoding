import type { ApprovalTier } from "../../shared/approvalTier";
import type {
  PermissionDecision,
  ToolOperation,
} from "../../shared/domain";

export interface ApprovalReviewContext {
  decision: PermissionDecision;
  operation: ToolOperation;
  tier: ApprovalTier;
}

export type ReviewerVerdict = {
  verdict: "deny" | "annotate" | "request_information" | "escalate";
  text: string;
};

export interface ApprovalReviewer {
  name: string;
  // Runtime validation also rejects malformed responses from untyped adapters.
  review(
    context: ApprovalReviewContext,
    signal: AbortSignal,
  ): Promise<ReviewerVerdict>;
}

export interface ReviewerChainOptions {
  reviewers: readonly ApprovalReviewer[];
  timeoutMs?: number;
  onUnavailable?: "ask_human" | "block";
}
