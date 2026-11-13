import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { noStoreByDefault } from '../no-store-by-default.js';

describe('no-store by default', () => {
  it('forbids storage and hands on', () => {
    const setHeader = vi.fn();
    const next = vi.fn();
    noStoreByDefault({} as Request, { setHeader } as unknown as Response, next as NextFunction);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs before every route, so a route can only loosen it on purpose', () => {
    const index = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
    const mounted = index.indexOf('app.use(noStoreByDefault)');
    expect(mounted).toBeGreaterThan(0);
    // Every router is mounted after it.
    const firstRoute = index.search(/app\.use\('\/(?!v1')[a-z]/);
    expect(firstRoute === -1 || mounted < firstRoute).toBe(true);
  });
});
