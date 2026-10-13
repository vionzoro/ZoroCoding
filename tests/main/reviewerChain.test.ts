import { afterEach, describe, expect, it, vi } from "vitest";

import { runReviewerChain } from "../../src/main/approval/reviewerChain";
import type { ApprovalReviewContext, ApprovalReviewer } from "../../src/main/approval/types";
import { classifyApprovalTier } from "../../src/shared/approvalTier";

const context: ApprovalReviewContext = {
  decision: { level: "ask", summary: "确认读取", reasons: ["项目外读取"], reasonCodes: ["read_outside_project"] },
  operation: { kind: "read_file", path: "../notes.txt" },
  tier: "T1",
};

afterEach(() => vi.useRealTimers());

describe("approval tiers", () => {
  it("uses only structured lower-risk codes and defaults missing or unknown codes high", () => {
    expect(classifyApprovalTier(context.decision)).toBe("T1");
    expect(classifyApprovalTier({ reasonCodes: ["not_allowlisted"] })).toBe("T1");
    expect(classifyApprovalTier({ reasonCodes: [] })).toBe("T2");
    expect(classifyApprovalTier({ reasonCodes: ["read_outside_project", "delete"] })).toBe("T2");
    expect(classifyApprovalTier({ reasonCodes: ["future_code"] } as never)).toBe("T2");
  });
});

describe("reviewer chain", () => {
  it("keeps annotations and information requests advisory, and escalates later reviewers to T2", async () => {
    const next = vi.fn(async (received: ApprovalReviewContext) => {
      expect(received.tier).toBe("T2");
      return { verdict: "request_information" as const, text: "补充用途" };
    });
    const result = await runReviewerChain(context, { reviewers: [
      { name: "一", review: async (received) => {
        received.decision.reasons.push("修改副本");
        return { verdict: "annotate", text: "核对范围" };
      } },
      { name: "二", review: async () => ({ verdict: "escalate", text: "提高级别" }) },
      { name: "三", review: next },
    ] }, new AbortController().signal);
    expect(result).toMatchObject({ tier: "T2", review: { outcome: "ask_human", entries: [
      { verdict: "annotate" }, { verdict: "escalate" }, { verdict: "request_information" },
    ] } });
    expect(context.decision.reasons).toEqual(["项目外读取"]);
  });

  it("treats a malformed reviewer name as unavailable", async () => {
    const review = vi.fn();
    const result = await runReviewerChain(context, { reviewers: [{ name: "", review }] }, new AbortController().signal);
    expect(result?.review).toMatchObject({ outcome: "ask_human", entries: [{ reviewer: "审查者", verdict: "unavailable" }] });
    expect(review).not.toHaveBeenCalled();
  });

  it("stops the chain after denial", async () => {
    const next = vi.fn();
    const result = await runReviewerChain(context, { reviewers: [
      { name: "一", review: async () => ({ verdict: "deny", text: "拒绝" }) },
      { name: "二", review: next },
    ] }, new AbortController().signal);
    expect(result?.review.outcome).toBe("deny");
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["ask_human", "block"] as const)("bounds a non-cooperative hang under %s", async (onUnavailable) => {
    vi.useFakeTimers();
    let reviewerSignal: AbortSignal | undefined;
    const promise = runReviewerChain(context, { timeoutMs: 20, onUnavailable, reviewers: [{
      name: "审查", review: async (_context, signal) => {
        reviewerSignal = signal;
        return new Promise<never>(() => {});
      },
    }] }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20);
    expect((await promise)?.review).toMatchObject({ outcome: onUnavailable, entries: [{ verdict: "unavailable" }] });
    expect(reviewerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, {}, { verdict: "approve", text: "yes" }, { verdict: "annotate", text: "" }, { verdict: "deny", text: "no", extra: true }])(
    "never approves malformed responses: %j", async (value) => {
      const reviewer = { name: "审查", review: async () => value } as ApprovalReviewer;
      const result = await runReviewerChain(context, { reviewers: [reviewer], onUnavailable: "block" }, new AbortController().signal);
      expect(result?.review.outcome).toBe("block");
    },
  );

  it("aborts immediately even if a reviewer ignores the signal", async () => {
    const controller = new AbortController();
    const promise = runReviewerChain(context, { reviewers: [{ name: "审查", review: async () => new Promise<never>(() => {}) }] }, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await promise).toBeNull();
  });
});
