import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

const USER_ID = '11111111-2222-3333-4444-555555555555';
const UPN = 'alice@contoso.com';
const TENANT = 'contoso.com';

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/** The ListUsers lookup resolveUserIdentity performs before any BEC call. */
function identityLookup(): Response {
  return jsonResponse([{ id: USER_ID, userPrincipalName: UPN }]);
}

type BecResult = {
  status: string;
  verified: boolean;
  findings: unknown;
  recheck: { tool: string; args: Record<string, unknown> } | null;
  alert: { severity: string; kind: string; title: string } | null;
};

describe('CippService becCheck — two-phase ExecBECCheck contract', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('polls with GUID rather than userId, and returns real findings', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(identityLookup())
      .mockResolvedValueOnce(jsonResponse({ GUID: USER_ID })) // kickoff
      .mockResolvedValueOnce(jsonResponse({ Waiting: true })) // still running
      .mockResolvedValueOnce(jsonResponse([{ rule: 'forward-to-external' }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.becCheck(TENANT, UPN, {
      intervalMs: 1000,
      maxAttempts: 4,
    }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    const urls = fetchMock.mock.calls.map((c) => c[0]);

    // Kickoff carries userId + userName + overwrite.
    expect(urls[1]).toContain('userId=' + USER_ID);
    expect(urls[1]).toContain('userName=alice%40contoso.com');
    expect(urls[1]).toContain('overwrite=true');

    // THE FIX: the poll must send GUID. Without it CIPP returns the GUID echo
    // forever and no finding can ever be retrieved.
    expect(urls[2]).toContain('GUID=' + USER_ID);
    expect(urls[2]).not.toContain('userId=');

    expect(result.status).toBe('complete');
    expect(result.verified).toBe(true);
    expect(result.findings).toEqual([{ rule: 'forward-to-external' }]);
    expect(result.alert?.severity).toBe('critical');
    expect(result.alert?.kind).toBe('finding');
  });

  it('treats a re-queued empty result as indeterminate, never as clean', async () => {
    jest.useFakeTimers();
    // CIPP branch 1: Results empty and Status is no longer 'Waiting', so it
    // re-queues and echoes the GUID back. Rendering that as "no findings" would
    // be a false all-clear on a possibly compromised account.
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(identityLookup())
      .mockResolvedValue(jsonResponse({ GUID: USER_ID }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.becCheck(TENANT, UPN, {
      intervalMs: 1000,
      maxAttempts: 5,
    }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.status).toBe('indeterminate');
    expect(result.verified).toBe(false);
    expect(result.findings).toBeNull();
    expect(result.alert?.kind).toBe('malfunction');
    expect(result.recheck?.args.useCached).toBe(true);
  });

  it('returns pending with a recheck instruction when the poll budget runs out', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(identityLookup())
      .mockResolvedValueOnce(jsonResponse({ GUID: USER_ID })) // kickoff
      .mockResolvedValue(jsonResponse({ Waiting: true })); // never finishes
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.becCheck(TENANT, UPN, {
      intervalMs: 1000,
      maxAttempts: 2,
    }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result.status).toBe('pending');
    expect(result.verified).toBe(false);
    expect(result.findings).toBeNull();
    expect(result.recheck?.tool).toBe('cipp_bec_check');
    expect(result.recheck?.args.useCached).toBe(true);
    expect(result.alert?.kind).toBe('malfunction');
  });

  it('useCached=true reads the stored row in place instead of restarting the run', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(identityLookup())
      .mockResolvedValueOnce(jsonResponse({ GUID: USER_ID })) // kickoff
      .mockResolvedValueOnce(jsonResponse([{ rule: 'cached-finding' }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.becCheck(TENANT, UPN, {
      useCached: true,
      intervalMs: 1000,
      maxAttempts: 3,
    }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    // No overwrite means CIPP does not re-queue an already-answered check.
    expect(fetchMock.mock.calls[1][0]).not.toContain('overwrite');
    expect(result.status).toBe('complete');
  });

  it('refuses to run against a user it cannot resolve', async () => {
    // resolveUserIdentity throws rather than passing an unresolved value through
    // as the cachebec row key, which would silently check the wrong record.
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValue(jsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.becCheck(TENANT, 'ghost@contoso.com')).rejects.toThrow(
      /could not resolve user/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
