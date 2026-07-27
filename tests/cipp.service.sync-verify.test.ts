// Verification envelopes for SYNCHRONOUS CIPP operations (resultEnvelope):
// resetMFA, revokeSessions, setOutOfOffice. Verified against CIPP-API tag 10.7.0
// (Invoke-ExecResetMFA / Invoke-ExecRevokeSessions / Invoke-ExecSetOoO) — each
// runs its Graph/EXO call inline and returns HTTP 500 on failure, so a 2xx means
// the operation completed; we still scan Results for a swallowed-error string.
import { CippService, VerifiedWriteEnvelope } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function mockResults(results: unknown) {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(jsonResponse({ Results: results }))
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('CippService synchronous-op verification', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => jest.restoreAllMocks());

  // ---- revokeSessions ----------------------------------------------------

  it('revokeSessions: verified on a success result', async () => {
    mockResults(['Successfully revoked sessions for alice@contoso.com']);
    const res = (await svc.revokeSessions('contoso.com', 'alice@contoso.com')) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toMatch(/revokeSignInSessions/);
    expect(res.recheck).toBeNull();
  });

  it('revokeSessions: unverified + recheck on a swallowed-error result', async () => {
    mockResults(['Failed to revoke sessions: user not found']);
    const res = (await svc.revokeSessions('contoso.com', 'alice@contoso.com')) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(false);
    expect(res.message).toMatch(/Do NOT report success/);
  });

  // ---- resetMFA ----------------------------------------------------------

  it('resetMFA: verified on a success result', async () => {
    mockResults(['Successfully reset MFA methods for alice@contoso.com']);
    const res = (await svc.resetMFA('contoso.com', 'alice@contoso.com')) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toMatch(/ExecResetMFA/);
  });

  it('resetMFA: unverified on an error result', async () => {
    mockResults(['Error: exception removing methods']);
    const res = (await svc.resetMFA('contoso.com', 'alice@contoso.com')) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(false);
  });

  // ---- setOutOfOffice ----------------------------------------------------

  it('setOutOfOffice enable: verified and sends AutoReplyState=Enabled', async () => {
    const fetchMock = mockResults(['Successfully set Out of Office for alice@contoso.com']);
    const res = (await svc.setOutOfOffice('contoso.com', 'alice@contoso.com', {
      enabled: true,
    })) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.AutoReplyState).toBe('Enabled');
  });

  it("setOutOfOffice: unverified on CIPP's blank-name \"Could not set\" tell", async () => {
    mockResults(['Could not set Out of Office for user: .']);
    const res = (await svc.setOutOfOffice('contoso.com', 'alice@contoso.com', {
      enabled: true,
    })) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(false);
    expect(res.recheck).not.toBeNull();
  });

  it('empty Results is inconclusive → unverified', async () => {
    mockResults([]);
    const res = (await svc.revokeSessions('contoso.com', 'alice@contoso.com')) as VerifiedWriteEnvelope;
    expect(res.verified).toBe(false);
  });
});
