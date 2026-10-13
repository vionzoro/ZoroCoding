import type { PermissionDecision } from "./domain";

export type ApprovalTier = "T1" | "T2";

// Only these bounded asks are lower risk. New or missing codes fail high.
const T1_CODES = new Set<string>([
  "read_outside_project",
  "not_allowlisted",
]);

export function classifyApprovalTier(
  decision: Pick<PermissionDecision, "reasonCodes">,
): ApprovalTier {
  return decision.reasonCodes.length > 0 &&
    decision.reasonCodes.every((code) => T1_CODES.has(code))
    ? "T1"
    : "T2";
}
