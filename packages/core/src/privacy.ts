export function redact(input: string, extraPatterns: RegExp[] = []): string {
  let result = input
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(https?:\/\/|postgres(?:ql)?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
  for (const pattern of extraPatterns)
    result = result.replace(pattern, "[REDACTED]");
  return result;
}
export function redactValue(input: unknown, patterns: RegExp[] = []): unknown {
  if (typeof input === "string") return redact(input, patterns);
  if (Array.isArray(input))
    return input.map((value) => redactValue(value, patterns));
  if (input !== null && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        redactValue(value, patterns),
      ]),
    );
  return input;
}
