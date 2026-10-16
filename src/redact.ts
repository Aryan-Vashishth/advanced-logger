/**
 * Free-text secret masking (redactText). Structured values are masked by key in actions.ts; this catches secrets
 * written into a message as text: `key=value`, `key: value`, `"key":"value"` (key containing one of redactKeys,
 * case-insensitive), and `Bearer <token>` / `Basic <credentials>`.
 */

const MASK = '***';
const CACHE = new Map<string, RegExp>();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pairPattern(keys: readonly string[]): RegExp | undefined {
  const usable = keys.filter((k) => k.trim() !== '');
  if (usable.length === 0) return undefined;
  const cacheKey = usable.join('\u0000');
  let re = CACHE.get(cacheKey);
  if (!re) {
    // <key containing a sensitive word><optional quote><: or => <optional quote><value up to a delimiter>
    const words = usable.map(escapeRe).join('|');
    re = new RegExp(`([\\w.-]*(?:${words})[\\w.-]*)(["']?[ \\t]*[:=][ \\t]*["']?)([^\\s"',;&}\\]]+)`, 'gi');
    CACHE.set(cacheKey, re);
  }
  return re;
}

const AUTH_SCHEME = /\b(Bearer|Basic)[ \t]+[\w.~+/-]+=*/gi;

/** `text` with sensitive values replaced by '***'. Returns the input unchanged when nothing matches. */
export function maskText(text: string, keys: readonly string[]): string {
  let out = text.replace(AUTH_SCHEME, `$1 ${MASK}`);
  const re = pairPattern(keys);
  // A value that is already masked, or is the auth scheme masked above ("Authorization: Bearer ***"), stays as is.
  if (re) out = out.replace(re, (m, key: string, sep: string, value: string) => (value === MASK || /^(bearer|basic)$/i.test(value) ? m : key + sep + MASK));
  return out;
}
