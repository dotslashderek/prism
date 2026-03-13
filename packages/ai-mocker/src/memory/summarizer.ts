const MAX_SUMMARY_LENGTH = 1200;

/**
 * Summarize a single JSON body into compact key-value notation.
 * Scalars are shown directly, arrays as `[N elements]`, objects as `{object}`.
 */
const summarizeBody = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      // Primitive JSON value — return as-is
      return String(parsed);
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return '{}';

    const parts = entries.map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: [${value.length} elements]`;
      if (typeof value === 'object' && value !== null) return `${key}: {object}`;
      return `${key}: ${String(value)}`;
    });

    return `{${parts.join(', ')}}`;
  } catch {
    // Not valid JSON — return the raw string (truncated if needed)
    return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  }
};

/**
 * Produce a compact human-readable summary of an HTTP request/response pair.
 *
 * Format: `[POST /users] request: {name: Alice} → response: {id: 42, name: Alice}`
 *
 * - Extracts first-level scalar key-value pairs from JSON bodies
 * - Arrays are noted as `[N elements]`
 * - Nested objects are noted as `{object}`
 * - Non-JSON bodies are included as-is
 * - Output is capped at ~1200 characters (~300 tokens)
 */
export const summarize = (
  method: string,
  path: string,
  reqBody?: string,
  resBody?: string,
): string => {
  const parts: string[] = [`[${method} ${path}]`];

  const reqSummary = summarizeBody(reqBody);
  if (reqSummary !== undefined) {
    parts.push(`request: ${reqSummary}`);
  }

  const resSummary = summarizeBody(resBody);
  if (resSummary !== undefined) {
    parts.push(`response: ${resSummary}`);
  }

  const joined = reqSummary !== undefined && resSummary !== undefined
    ? `${parts[0]} ${parts[1]} → ${parts[2]}`
    : parts.join(' ');

  if (joined.length <= MAX_SUMMARY_LENGTH) return joined;

  return joined.slice(0, MAX_SUMMARY_LENGTH - 1) + '…';
};
