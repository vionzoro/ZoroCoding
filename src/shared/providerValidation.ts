import { z } from "zod";

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

export interface ProviderSecurityInput {
  name: string;
  kind: "kimi" | "openai-compatible";
  baseUrl: string;
  modelId: string;
  contextLength: number;
  headers: Record<string, string>;
  isDefault?: boolean;
  billingNote?: string;
  dashboardUrl?: string;
}

export const providerBaseObject = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["kimi", "openai-compatible"]),
    baseUrl: z.string().trim().url(),
    modelId: z.string().trim().min(1).max(200),
    contextLength: z.number().int().min(1_024).max(2_000_000),
    headers: z.record(z.string(), z.string()),
    isDefault: z.boolean(),
    billingNote: z.string().max(200).optional(),
    dashboardUrl: z
      .union([z.string().trim().url(), z.literal("")])
      .optional(),
  })
  .strict();

export function addEndpointSecurityIssues(
  endpoint: string,
  context: z.RefinementCtx,
  field = "baseUrl",
): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname,
  );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localhost)
  ) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "远程模型地址必须使用 HTTPS；HTTP 仅允许本机地址。",
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Base URL 不能包含用户名或密码。",
    });
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Base URL 不能包含查询参数或片段。",
    });
  }
}

export function addProviderSecurityIssues(
  input: ProviderSecurityInput,
  context: z.RefinementCtx,
): void {
  addEndpointSecurityIssues(input.baseUrl, context);

  const seenHeaders = new Set<string>();
  for (const [name, value] of Object.entries(input.headers)) {
    const normalized = name.toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      context.addIssue({
        code: "custom",
        path: ["headers", name],
        message: "请求头名称格式无效。",
      });
    }
    if (FORBIDDEN_HEADERS.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: ["headers", name],
        message: `不允许自定义 ${name} 请求头。`,
      });
    }
    if (seenHeaders.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: ["headers", name],
        message: "请求头名称不能只通过大小写重复。",
      });
    }
    if (/[\r\n]/.test(value)) {
      context.addIssue({
        code: "custom",
        path: ["headers", name],
        message: "请求头值不能包含换行符。",
      });
    }
    seenHeaders.add(normalized);
  }
}

export const secureProviderSchema = providerBaseObject.superRefine(
  addProviderSecurityIssues,
);

export function assertProviderSecurity(
  input: ProviderSecurityInput,
): ProviderSecurityInput {
  secureProviderSchema.parse({
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    contextLength: input.contextLength,
    headers: input.headers,
    isDefault: input.isDefault ?? false,
  });
  return input;
}
