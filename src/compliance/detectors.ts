export type Kind = 'secret' | 'pii';

export interface Detector {
  name: string;
  kind: Kind;
  /** Must carry the `d` flag (indices) and `g`. Patterns never match across '\n' and use bounded quantifiers (ReDoS-safe by construction). */
  re: RegExp;
  /** Capture group to redact (default: whole match). */
  group?: number;
  /** Cheap, non-global pre-filter: skip the regex entirely when the line cannot contain a match. */
  hint?: RegExp;
  validate?: (value: string, line: string, start: number) => boolean;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function luhn(digits: string): boolean {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const PLACEHOLDER = /^(?:undefined|null|none|true|false|changeme|change[_-]?me|example|placeholder|redacted|dummy|test|secret|password|your[_-].*|x{4,}|\*{4,}|<.*>|\$\{.*\}|\{\{.*\}\})$/i;
const looksLikeCode = (v: string): boolean =>
  /[()]/.test(v) || /^[$<{]/.test(v) || v.includes('${') || v.includes('{{') ||
  /^(?:process|os|env|config|this|self|req|args|params|opts?|options|settings)[.[]/i.test(v);

const EXAMPLE_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'localhost', 'test.com']);

/** Order is priority: secrets before PII, and Luhn-validated cards before the looser phone pattern. */
export const DETECTORS: Detector[] = [
  { name: 'private_key', kind: 'secret', hint: /-----BEGIN/,
    re: /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----[^\n]{0,16384}?-----END[A-Z0-9 ]{0,40}PRIVATE KEY-----/dg },
  { name: 'aws_access_key_id', kind: 'secret', hint: /A(?:KIA|SIA|GPA|IDA|ROA|NPA|NVA|IPA)/,
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z2-7]{16}\b/dg },
  { name: 'aws_secret_access_key', kind: 'secret', hint: /secret/i, group: 1,
    re: /aws_?secret_?(?:access_?)?key["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi },
  { name: 'github_token', kind: 'secret', hint: /gh[pousr]_/,
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/dg },
  { name: 'github_pat', kind: 'secret', hint: /github_pat_/,
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/dg },
  { name: 'stripe_key', kind: 'secret', hint: /[sr]k_(?:live|test)_/,
    re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,99}\b/dg },
  { name: 'slack_token', kind: 'secret', hint: /xox/,
    re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,200}\b/dg },
  { name: 'anthropic_key', kind: 'secret', hint: /sk-ant-/,
    re: /\bsk-ant-[A-Za-z0-9_-]{20,255}/dg },
  { name: 'openai_style_key', kind: 'secret', hint: /sk-/,
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,255}/dg,
    validate: v => shannonEntropy(v) >= 4.0 },
  { name: 'google_api_key', kind: 'secret', hint: /AIza/,
    re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/dg },
  { name: 'jwt', kind: 'secret', hint: /eyJ/,
    re: /\beyJ[A-Za-z0-9_-]{10,1400}\.eyJ[A-Za-z0-9_-]{10,1400}\.[A-Za-z0-9_-]{10,1400}/dg },
  { name: 'auth_header', kind: 'secret', hint: /authorization/i, group: 1,
    re: /authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+([A-Za-z0-9._~+/=-]{16,512})/dgi },
  { name: 'url_credentials', kind: 'secret', hint: /:\/\//, group: 1,
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:([^\s@/]{3,128})@/dg,
    validate: v => !/^[$<{]/.test(v) },
  // Highest false-positive rate of all detectors: keyword + assignment + entropy gate. See docs/compliance.md.
  { name: 'secret_assignment', kind: 'secret', hint: /key|secret|token|pass|pwd/i, group: 1,
    re: /(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|passwd|password|pwd|client[_-]?secret|private[_-]?key)[A-Za-z0-9_]{0,24}["']?[ \t]*[:=][ \t]*["']?([^\s"',;]{8,200})/dgi,
    validate: v => {
      if (v.startsWith('[REDACTED')) return false;                 // never re-redact our own placeholders
      if (PLACEHOLDER.test(v) || looksLikeCode(v)) return false;
      if (/^[A-Za-z_]+$/.test(v)) return v.length >= 16 && shannonEntropy(v) >= 3.5;   // identifiers/types, not secrets
      return shannonEntropy(v) >= 2.5;
    } },

  { name: 'email', kind: 'pii', hint: /@/,
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/dg,
    validate: (v, line, start) => {
      const [local, domain = ''] = v.split('@');
      if (/:\/\/[^\s/@]*:$/.test(line.slice(0, start))) return false;   // scheme://user:<pw>@host belongs to url_credentials
      return local !== 'git' && !EXAMPLE_DOMAINS.has(domain.toLowerCase());
    } },
  { name: 'ssn', kind: 'pii', hint: /\d{3}-\d{2}-\d{4}/,
    re: /\b\d{3}-\d{2}-\d{4}\b/dg,
    validate: v => {
      const [a, g, s] = v.split('-');
      return a !== '000' && a !== '666' && !a!.startsWith('9') && g !== '00' && s !== '0000';
    } },
  { name: 'credit_card', kind: 'pii', hint: /\d/,
    re: /\b\d(?:[ -]?\d){12,18}\b/dg,
    validate: v => { const d = v.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { name: 'phone', kind: 'pii', hint: /\d/,
    re: /(?<![\w.])\+?\d[\d ().-]{7,20}\d(?![\w:])/dg,
    validate: v => {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return false;
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false;                      // dates
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return false;               // IPv4
      if (!v.startsWith('+') && !v.includes('(') && !/[ -]/.test(v)) return false;   // bare digits / dotted: timestamps, ids
      return !/^(\d)\1+$/.test(digits);
    } },
  // Best-effort US-style street addresses. Regexes cannot do names or non-US formats: see docs/compliance.md.
  { name: 'street_address', kind: 'pii', hint: /\d/,
    re: /\b\d{1,6}[ \t]+(?:[A-Z][a-z]+\.?[ \t]+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy)\b\.?(?:,?[ \t]+(?:Apt|Apartment|Suite|Ste|Unit)\.?[ \t]*#?\w{1,6})?(?:,[ \t]+[A-Z][A-Za-z.]*(?:[ \t][A-Z][A-Za-z.]*){0,3},[ \t]+[A-Z]{2}[ \t]+\d{5}(?:-\d{4})?)?/dg },
];
