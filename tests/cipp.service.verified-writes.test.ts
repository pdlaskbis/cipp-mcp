// Tests for the verification envelope on mutating CIPP writes.
//
// These assert the behaviour that makes the envelope worth having: a write is
// reported `verified: true` ONLY when a Microsoft-side readback confirms it, and
// a write CIPP accepted but that could not be confirmed returns `verified: false`
// with a recheck instruction and an explicit "do NOT report success" — never a
// success message on the bare ack.
//
// Readback fields are grounded in KelvinTegelaar/CIPP-API tag 10.7.0,
// Invoke-ListUsers.ps1: the ListUsers UserID (by-id) select returns
// accountEnabled and lastPasswordChangeDateTime.
import { CippService, VerifiedWriteEnvelope } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const GUID = '11111111-1111-1111-1111-111111111111';

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/**
 * Route fetch by endpoint: GET ListUsers returns the next queued user row
 * (clamped to the last, so a single row is returned on every poll); every other
 * call is a write ack. Returns the mock so callers can inspect write bodies.
 */
function router(userRows: Array<Record<string, unknown>>) {
  let getCall = 0;
  return jest.fn((url: string, init: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.includes('/api/ListUsers')) {
      const row = userRows[Math.min(getCall, userRows.length - 1)] ?? {};
      getCall++;
      return Promise.resolve(jsonResponse([row]));
    }
    return Promise.resolve(jsonResponse({ Results: ['accepted'] }));
  });
}

function postBodyFor(fetchMock: ReturnType<typeof router>, endpoint: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => (init?.method ?? 'GET') !== 'GET' && String(url).includes(endpoint)
  );
  if (!call) throw new Error(`no write call to ${endpoint}`);
  return JSON.parse((call[1].body as string) ?? '{}');
}

describe('CippService verified writes', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ---- disableUser -------------------------------------------------------

  it('disableUser: verified when accountEnabled reads back false', async () => {
    const fetchMock = router([{ accountEnabled: false }]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = (await svc.disableUser('contoso.com', GUID)) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.status).toBe('verified');
    expect(res.verifiedBy).toBe('accountEnabled');
    expect(res.recheck).toBeNull();
    expect(res.message).not.toMatch(/Do NOT report success/);
    // The write itself carried ID.
    expect(postBodyFor(fetchMock, 'ExecDisableUser').ID).toBe(GUID);
  });

  it('disableUser: unverified + recheck when accountEnabled never flips', async () => {
    jest.useFakeTimers();
    global.fetch = router([{ accountEnabled: true }]) as unknown as typeof fetch;

    const promise = svc.disableUser('contoso.com', GUID) as Promise<VerifiedWriteEnvelope>;
    await jest.advanceTimersByTimeAsync(31_000);
    const res = await promise;

    expect(res.verified).toBe(false);
    expect(res.status).toBe('unverified');
    expect(res.recheck).not.toBeNull();
    expect(res.message).toMatch(/Do NOT report success/);
  });

  // ---- resetPassword -----------------------------------------------------

  it('resetPassword: verified when lastPasswordChangeDateTime advances', async () => {
    const fetchMock = router([
      { lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }, // baseline
      { lastPasswordChangeDateTime: '2026-07-26T00:00:00Z' }, // after reset
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = (await svc.resetPassword('contoso.com', GUID, 'S3cret!')) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('lastPasswordChangeDateTime');
    expect(res.recheck).toBeNull();
    // Explicit password is forwarded to CIPP.
    expect(postBodyFor(fetchMock, 'ExecResetPass').newPassword).toBe('S3cret!');
  });

  it('resetPassword: unverified when the timestamp does not advance', async () => {
    jest.useFakeTimers();
    global.fetch = router([
      { lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }, // baseline
      { lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }, // unchanged
    ]) as unknown as typeof fetch;

    const promise = svc.resetPassword('contoso.com', GUID) as Promise<VerifiedWriteEnvelope>;
    await jest.advanceTimersByTimeAsync(31_000);
    const res = await promise;

    expect(res.verified).toBe(false);
    expect(res.status).toBe('unverified');
    expect(res.message).toMatch(/Do NOT report success/);
  });

  it('resetPassword: omits newPassword when none is supplied', async () => {
    const fetchMock = router([
      { lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' },
      { lastPasswordChangeDateTime: '2026-07-26T00:00:00Z' },
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.resetPassword('contoso.com', GUID);

    expect(postBodyFor(fetchMock, 'ExecResetPass').newPassword).toBeUndefined();
  });
});
