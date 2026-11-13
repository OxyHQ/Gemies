import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person's reads never spend the per-minute burst window meant for writes and model calls.
 *
 * 2026-11-13: the free tier's 20 a minute was shared by the conversation list, each conversation
 * opened, the sidebar's prefetches and every background refresh, so the next conversation the
 * owner opened was refused with a 429. Reads are paced by the API-wide per-person budget
 * (`createOxyRateLimit`), never by this window.
 */
const mocks = vi.hoisted(() => ({
  checkLimit: vi.fn(async () => ({ allowed: false, current: 21, limit: 20, resetInSeconds: 30 })),
  findActiveSubscription: vi.fn(async () => null),
}));
vi.mock('../../lib/sliding-window-limiter.js', () => ({ checkLimit: mocks.checkLimit }));
vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findActiveSubscription: mocks.findActiveSubscription,
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/telemetry/apiKeyUsageRepository.js', () => ({ recordApiKeyUsage: vi.fn() }));

import { apiKeyRateLimit } from '../api-key-rate-limit.js';

function call(method: string) {
  const req = { method, user: { id: 'owner' }, headers: {} } as unknown as Request;
  const json = vi.fn();
  const res = {
    status: vi.fn(() => ({ json })),
    setHeader: vi.fn(),
    set: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, json };
}

describe('the per-minute window', () => {
  beforeEach(() => mocks.checkLimit.mockClear());

  it.each(['GET', 'HEAD'])('lets a person’s %s through without counting it', async (method) => {
    const { req, res, next } = call(method);
    await apiKeyRateLimit(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.checkLimit).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PATCH', 'DELETE'])(
    'still counts a person’s %s, and refuses past it',
    async (method) => {
      const { req, res, next } = call(method);
      await apiKeyRateLimit(req, res, next);
      expect(mocks.checkLimit).toHaveBeenCalledOnce();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    },
  );
});
