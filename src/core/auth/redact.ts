/**
 * The only place secrets are masked.
 *
 * WEEEK issues long-lived personal access tokens with no scopes and no rotation, so a token
 * that leaks into a log, a bug report or a terminal recording grants full workspace access
 * until someone revokes it by hand. Centralising the masking is what makes "the token never
 * appears in output" a property that can be tested, rather than a habit that has to hold at
 * every call site.
 */

/** Registered secrets, longest first so overlapping values mask completely. */
const secrets = new Set<string>()

/** Values too short or too generic to mask without garbling unrelated output. */
const MIN_SECRET_LENGTH = 8

export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) secrets.add(value)
}

export function clearSecrets(): void {
  secrets.clear()
}

/** A short, non-reversible hint: the last 4 characters. Never enough to reconstruct a token. */
export function tokenHint(token: string): string {
  if (token.length <= 4) return '****'
  return `****${token.slice(-4)}`
}

/**
 * Replaces every registered secret in a string, plus anything that structurally looks like a
 * credential (Authorization headers, token-ish query parameters) even if it was never
 * registered — verbose output should be safe by default, not only when we remembered.
 */
export function redact(text: string): string {
  let result = text

  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(tokenHint(secret))
  }

  result = result.replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1****')
  result = result.replace(
    /((?:token|api[_-]?key|access[_-]?token|authorization)["'\s:=]+)([A-Za-z0-9._~+/-]{8,})/gi,
    '$1****',
  )

  return result
}

/** Deep-redacts a value for structured output, preserving shape. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const looksSecret = /token|secret|password|authorization|api[_-]?key/i.test(key)
      out[key] =
        looksSecret && typeof inner === 'string' && inner.length >= MIN_SECRET_LENGTH
          ? tokenHint(inner)
          : redactValue(inner)
    }
    return out as T
  }

  return value
}
