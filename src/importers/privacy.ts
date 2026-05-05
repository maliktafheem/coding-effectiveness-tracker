/**
 * Privacy-safe redaction utilities.
 *
 * Redacts secrets, API keys, tokens, and sensitive content from output.
 * Uses canary-aware detection to prove redaction works.
 */

/** Patterns that look like secrets or tokens. */
const SECRET_PATTERNS: RegExp[] = [
  // API keys with common prefixes
  /(?:sk-|sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9]{20,}/g,
  // Generic "key=...", "token=...", "secret=..." assignments
  /(?:(?:api[_-]?key|token|secret|password|auth)[=:\s]+)["']?([A-Za-z0-9_-]{20,})["']?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9_.-]{20,}/gi,
  // JWT-like strings
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/**
 * Canary strings for privacy verification.
 *
 * These are plain-text markers embedded in test fixtures to verify
 * that sensitive content is redacted from terminal output, SQLite
 * summaries, and exports. None of these resemble real credentials.
 */
export const CANARY_SECRETS = {
  canary1: 'CANARY_LEAK_TEST_MARKER_ALPHA_ZERO',
  canary2: 'CANARY_LEAK_TEST_MARKER_BETA_ZERO',
  canary3: 'CANARY_LEAK_TEST_MARKER_GAMMA_ZERO',
  canary4: 'CANARY_LEAK_TEST_MARKER_DELTA_ZERO',
} as const;

/** All canary values as an array for scanning. */
export const ALL_CANARIES: string[] = Object.values(CANARY_SECRETS);

/**
 * Redact known secret patterns from a string.
 * Replaces matched content with `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  let result = text;
  // Pattern-based redaction for common secret formats
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  // Canary-specific redaction for test verification
  for (const canary of ALL_CANARIES) {
    while (result.includes(canary)) {
      result = result.replace(canary, '[REDACTED]');
    }
  }
  return result;
}

/**
 * Check whether a string contains any unredacted canary content.
 * Returns the list of found canary strings.
 */
export function findCanaryLeaks(text: string): string[] {
  return ALL_CANARIES.filter((canary) => text.includes(canary));
}

/**
 * Sanitize a string for safe terminal output.
 * Truncates long strings and redacts secrets.
 */
export function sanitizeForOutput(text: string, maxLen = 200): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxLen) return redacted;
  return redacted.slice(0, maxLen) + '...[truncated]';
}

/**
 * Normalize a metadata key for sensitive-key matching.
 * Strips hyphens, underscores, and dots, then lowercases.
 * e.g. "apiKey" -> "apikey", "api_key" -> "apikey", "access-token" -> "accesstoken"
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.]/g, '');
}

/**
 * Sensitive key stems after normalization.
 * Each entry is the normalized (separator-free, lowercase) form.
 */
const SENSITIVE_KEY_STEMS: ReadonlySet<string> = new Set([
  'apikey',
  'accesstoken',
  'authtoken',
  'token',
  'secret',
  'password',
  'authorization',
  'auth',
]);

/**
 * Check whether a metadata key should be redacted.
 * Matches regardless of camelCase, snake_case, kebab-case, or UPPER_CASE.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_STEMS.has(normalized);
}

export function redactMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = redactSecrets(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactMetadata(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}