/**
 * Last line of defence for free text (error messages and stacks) that may embed a secret, for example a database
 * error that echoes a statement, or an exception thrown with a token in its message. Structured fields are redacted
 * by path (see logger.ts); this covers strings, where paths cannot reach.
 */
const PATTERNS: [RegExp, string][] = [
  [/\$argon2[a-z]*\$[^\s'"`]+/g, '[REDACTED:password-hash]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED:jwt]'],
  [/inv_[0-9a-f-]{36}_[A-Za-z0-9_-]{16,}/gi, '[REDACTED:invitation]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [
    /(token|secret|password|passwd|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi,
    '$1$2[REDACTED]',
  ],
  [/\b[A-Za-z0-9_-]{43}\b/g, '[REDACTED:token]'], // 256-bit base64url (our opaque tokens)
  [/(postgres(?:ql)?|redis|amqp|mongodb):\/\/[^\s'"`@]*@/gi, '$1://[REDACTED]@'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[REDACTED:email]'],
];

export function scrubSecrets(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
