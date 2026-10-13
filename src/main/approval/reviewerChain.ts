import { z } from "zod";

import {
  approvalReviewEntrySchema,
  type ApprovalReview,
} from "../../shared/domain";
import type { ApprovalReviewContext, ReviewerChainOptions } from "./types";

const verdictSchema = approvalReviewEntrySchema.omit({ reviewer: true }).extend({
  verdict: z.enum(["deny", "annotate", "request_information", "escalate"]),
});

export async function runReviewerChain(
  context: ApprovalReviewContext,
  options: ReviewerChainOptions,
  signal: AbortSignal,
): Promise<{ tier: ApprovalReviewContext["tier"]; review: ApprovalReview } | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new Error("审查超时时间必须是有效的正数。");
  }
  if (options.reviewers.length > 100) {
    throw new Error("审查者数量不能超过 100。");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const review: ApprovalReview = { outcome: "ask_human", entries: [] };
  let tier = context.tier;
  try {
    for (const reviewer of options.reviewers) {
      if (signal.aborted) return null;
      let name = "审查者";
      let finishAbort: (() => void) | undefined;
      try {
        name = z.string().min(1).max(256).parse(reviewer.name);
        const aborted = new Promise<never>((_resolve, reject) => {
          finishAbort = () => reject(new DOMException("Aborted", "AbortError"));
          controller.signal.addEventListener("abort", finishAbort, { once: true });
          if (controller.signal.aborted) finishAbort();
        });
        const result = await Promise.race([
          aborted,
          Promise.resolve().then(() => {
            if (controller.signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            return reviewer.review(
              structuredClone({ ...context, tier }),
              controller.signal,
            );
          }),
        ]);
        const verdict = verdictSchema.parse(result);
        review.entries.push({ reviewer: name, ...verdict });
        if (verdict.verdict === "deny") {
          review.outcome = "deny";
          break;
        }
        if (verdict.verdict === "escalate") tier = "T2";
      } catch {
        if (signal.aborted) return null;
        review.entries.push({
          reviewer: name,
          verdict: "unavailable",
          text: "独立审查未能完成，请人工确认。",
        });
        if (options.onUnavailable === "block") {
          review.outcome = "block";
          break;
        }
      } finally {
        if (finishAbort !== undefined) {
          controller.signal.removeEventListener("abort", finishAbort);
        }
      }
    }
    return signal.aborted ? null : { tier, review };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
