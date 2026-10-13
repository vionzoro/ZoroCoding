/** Best-effort secret filtering; providers must also filter sensitive records. */
export function redactMemoryText(text: string): string {
  return text
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
      "[已隐藏]",
    )
    .replace(
      /["']?\b(?:api[_-]?key|access[_-]?token|token|password|secret)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "[已隐藏]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [已隐藏]");
}
