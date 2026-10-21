import { describe, expect, it } from 'vitest';
import { httpsLink } from './link.js';

describe('httpsLink', () => {
  it('keeps plain https links', () => {
    expect(httpsLink('https://steadfast.com.bd/t/ABC123')).toBe(
      'https://steadfast.com.bd/t/ABC123',
    );
    expect(httpsLink('  https://example.test/t?id=1 ')).toBe('https://example.test/t?id=1');
  });
  it.each([
    'http://example.test/t',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html;base64,AAAA',
    'ftp://example.test/x',
    'https://u:p@example.test/',
    'https://u@example.test/',
    '//example.test/x',
    '/relative/path',
    '',
    'x'.repeat(3000),
  ])('drops %s', (v) => expect(httpsLink(v)).toBeUndefined());
  it('drops non-strings', () => {
    expect(httpsLink(null)).toBeUndefined();
    expect(httpsLink(42)).toBeUndefined();
  });
});
