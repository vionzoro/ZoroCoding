import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { approvalReviewEntrySchema } from "../../shared/domain";
import {
  HttpTransport,
  IntegrationError,
  type HttpTransportOptions,
} from "../integrations/httpTransport";
import type {
  ApprovalReviewContext,
  ApprovalReviewer,
  ReviewerVerdict,
} from "./types";

export interface HttpReviewerOptions extends HttpTransportOptions {
  name: string;
  /** Main-process authority epoch. A changed epoch invalidates an in-flight review. */
  getEpoch: () => number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function approvalActionDigest(context: ApprovalReviewContext): string {
  return createHash("sha256").update(canonical(context)).digest("hex");
}
const verdictSchema = approvalReviewEntrySchema.omit({ reviewer: true }).extend({
  protocol: z.literal("approval-review/v0"),
  request_id: z.string().uuid(),
  action_digest: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.number().int().nonnegative().safe(),
  verdict: z.enum(["deny", "annotate", "request_information", "escalate"]),
}).strict();

export class HttpReviewer implements ApprovalReviewer {
  readonly name: string;
  private readonly http: HttpTransport;
  private readonly getEpoch: () => number;
  constructor(options: HttpReviewerOptions) {
    this.name = z.string().min(1).max(256).parse(options.name);
    this.http = new HttpTransport(options);
    this.getEpoch = options.getEpoch;
  }
  async review(
    context: ApprovalReviewContext,
    signal: AbortSignal,
  ): Promise<ReviewerVerdict> {
    const epoch = this.getEpoch();
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new IntegrationError("invalid_epoch");
    }
    const snapshot = structuredClone(context);
    const request_id = randomUUID();
    const action_digest = approvalActionDigest(snapshot);
    const response = await this.http.post({
      protocol: "approval-review/v0",
      request_id,
      action_digest,
      epoch,
      context: snapshot,
    }, signal);
    const result = verdictSchema.safeParse(response.body);
    if (!result.success) {
      throw new IntegrationError("malformed_verdict");
    }
    if (signal.aborted) {
      throw new IntegrationError("cancelled");
    }
    if (
      result.data.request_id !== request_id ||
      result.data.action_digest !== action_digest ||
      result.data.epoch !== epoch ||
      this.getEpoch() !== epoch
    ) {
      throw new IntegrationError("verdict_mismatch");
    }
    return { verdict: result.data.verdict, text: result.data.text };
  }
}
