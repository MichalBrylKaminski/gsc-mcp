import { describe, expect, it, vi } from 'vitest';
import { classifyGoogleError, toToolError } from '../src/errors.js';
import { CircuitBreaker, withRetry } from '../src/limits/retry.js';
import { googleError } from './helpers.js';

const fast = { baseDelayMs: 1, maxDelayMs: 2 };

describe('classifyGoogleError', () => {
  it('recognises rate, load, daily, permission and server errors', () => {
    expect(classifyGoogleError(googleError(429, 'rateLimitExceeded')).kind).toBe('rateLimit');
    expect(classifyGoogleError(googleError(403, 'userRateLimitExceeded')).kind).toBe('rateLimit');
    expect(classifyGoogleError(googleError(429, 'rateLimitExceeded', 'Search Analytics load quota exceeded')).kind).toBe('loadQuota');
    expect(classifyGoogleError(googleError(403, 'dailyLimitExceeded')).kind).toBe('dailyQuota');
    expect(classifyGoogleError(googleError(403, 'forbidden')).kind).toBe('permission');
    expect(classifyGoogleError(googleError(503)).kind).toBe('server');
  });

  it('treats OAuth token errors as auth errors', () => {
    const err = Object.assign(new Error('invalid_grant'), {
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid grant: account not found' } },
    });
    expect(classifyGoogleError(err)).toMatchObject({ kind: 'auth', reason: 'invalid_grant' });
    expect(toToolError(err).code).toBe('AUTH_ERROR');
  });

  it('treats "per day" quota errors as daily, whatever the reason code', () => {
    expect(classifyGoogleError(googleError(429, 'rateLimitExceeded', "Quota exceeded for quota metric 'Queries' per day")).kind).toBe('dailyQuota');
    const withDetails = googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded');
    (withDetails.response.data.error as Record<string, unknown>).details = [{ metadata: { quota_limit: 'UrlInspectionPerDayPerSite' } }];
    expect(classifyGoogleError(withDetails).kind).toBe('dailyQuota');
    expect(toToolError(withDetails).details.resetAt).toMatch(/T0[78]:00:00.000Z$/);
  });

  it('classifies network errors without a response as retryable', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyGoogleError(err).kind).toBe('network');
    expect(classifyGoogleError(Object.assign(new Error('x'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })).kind).toBe('network');
    expect(classifyGoogleError(new Error('boom')).kind).toBe('other');
  });

  it('reads Retry-After', () => {
    expect(classifyGoogleError(googleError(429, 'rateLimitExceeded', 'x', { 'retry-after': '7' })).retryAfterMs).toBe(7000);
  });
});

describe('withRetry', () => {
  it('retries rate limits and 5xx, then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(googleError(429, 'rateLimitExceeded')).mockRejectedValueOnce(googleError(500)).mockResolvedValue('ok');
    await expect(withRetry(fn, fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(googleError(503));
    await expect(withRetry(fn, { ...fast, maxRetries: 2 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry permission, load-quota or long Retry-After errors', async () => {
    for (const err of [
      googleError(403, 'forbidden'),
      googleError(429, 'rateLimitExceeded', 'load quota exceeded'),
      googleError(429, 'rateLimitExceeded', 'x', { 'retry-after': '3600' }),
    ]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, fast)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('CircuitBreaker', () => {
  it('stays open for the cooldown and keeps the longer of two trips', () => {
    const b = new CircuitBreaker();
    b.trip('k', 1000, 'loadQuota', 0);
    b.trip('k', 100, 'rateLimit', 0);
    expect(b.check('k', 500)).toEqual({ remainingMs: 500, reason: 'loadQuota' });
    expect(b.check('k', 1000)).toBeUndefined();
  });
});

describe('toToolError', () => {
  it('tells the user which service account to add on a 403', () => {
    const e = toToolError(googleError(403, 'forbidden', 'User does not have sufficient permission'), {
      siteUrl: 'sc-domain:a.com',
      serviceAccountEmail: 'bot@p.iam.gserviceaccount.com',
    });
    expect(e.code).toBe('PERMISSION_DENIED');
    expect(e.message).toContain('bot@p.iam.gserviceaccount.com');
    expect(e.message).toContain('sc-domain:a.com');
  });
});

describe('withRetry network errors', () => {
  it('retries a dropped connection', async () => {
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).mockResolvedValue('ok');
    await expect(withRetry(fn, fast)).resolves.toBe('ok');
  });
});
