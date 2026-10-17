import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireBearerToken } from './app.setup.js';

function run(method: string, authorization?: string) {
  const json = vi.fn();
  const type = vi.fn(() => ({ json }));
  const status = vi.fn(() => ({ type }));
  const next = vi.fn() as unknown as NextFunction;
  requireBearerToken(
    { method, headers: authorization ? { authorization } : {} } as Request,
    { status } as unknown as Response,
    next,
  );
  return { next, status, json };
}

describe('requireBearerToken (the large-body import route)', () => {
  it('lets a request with a bearer token through', () => {
    const r = run('POST', 'Bearer abc');
    expect(r.next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('refuses a request without one, as problem details', () => {
    const r = run('POST');
    expect(r.next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('refuses a non-bearer scheme', () => {
    expect(run('POST', 'Basic abc').status).toHaveBeenCalledWith(401);
  });

  it('lets a browser CORS preflight through: it never carries a token, and CORS must answer it', () => {
    const r = run('OPTIONS');
    expect(r.next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });
});
