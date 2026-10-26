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
  caseId: string | null;
  truncated?: Record<string, number>;
  page?: Record<string, unknown>;
  incompleteChecks?: string[];
  assessment?: { severity: string; reasons: string[] };
  verified: boolean;
  findings: unknown;
  recheck: { tool: string; args: Record<string, unknown> } | null;
  alert: { severity: string; kind: string; title: string } | null;
};

const CASE_ID = 'BEC-20261026045652-99c8f6';

describe('CippService becCheck — case-based ExecBECCheck contract', () => {
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

  function mockFetch(...responses: Response[]) {
    const fn = jest.fn<Promise<Response>, [string, RequestInit]>();
    for (const r of responses) fn.mockResolvedValueOnce(r);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('starts a case with POST userid/userName and polls by the returned case id', async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetch(
      identityLookup(),
      jsonResponse({ GUID: CASE_ID, CaseId: CASE_ID, Status: 'Waiting' }),
      jsonResponse({
        CaseId: CASE_ID,
        Status: 'Running',
        Waiting: true,
        Progress: { Status: 'running', Steps: [{ Title: 'Sign-ins', Status: 'running' }] },
      }),
      jsonResponse({
        NewRules: [{ Name: 'Silent forward', Enabled: true, ForwardTo: ['mallory@evil.example'] }],
        AddedApps: [],
        SuspectUserSignIns: [],
        MailboxPermissionChanges: [],
        ExtractedAt: '2026-10-26T05:03:53Z',
        ExtractResult: 'Successfully extracted logs from auditlog',
        Run: { CaseId: CASE_ID, Status: 'Completed' },
      })
    );

    const promise = svc.becCheck(TENANT, UPN, { intervalMs: 1000, maxAttempts: 4 }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(5000);
    const result = await promise;

    const [kickUrl, kickInit] = fetchMock.mock.calls[1];
    expect(kickInit.method).toBe('POST');
    expect(kickUrl).not.toContain('?');
    expect(JSON.parse(String(kickInit.body))).toEqual({ tenantFilter: TENANT, userid: USER_ID, userName: UPN });

    // THE FIX: polls carry the case id, never the user's object id.
    const pollUrl = fetchMock.mock.calls[2][0];
    expect(pollUrl).toContain('GUID=' + CASE_ID);
    expect(pollUrl).not.toContain(USER_ID);

    expect(result.status).toBe('complete');
    expect(result.caseId).toBe(CASE_ID);
    expect(result.verified).toBe(true);
    expect(result.alert?.severity).toBe('critical');
  });

  it('never reports a not-found case as complete (the old false all-clear)', async () => {
    jest.useFakeTimers();
    mockFetch(
      identityLookup(),
      jsonResponse({ Waiting: false, Error: `BEC run ${CASE_ID} was not found for ${TENANT}` })
    );

    const promise = svc.becCheck(TENANT, UPN, { caseId: CASE_ID, intervalMs: 1000, maxAttempts: 2 }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.status).toBe('indeterminate');
    expect(result.verified).toBe(false);
    expect(result.findings).toBeNull();
    expect(result.alert?.kind).toBe('malfunction');
  });

  it('reports a failed run as failed, with a recheck that starts a new case', async () => {
    jest.useFakeTimers();
    mockFetch(
      identityLookup(),
      jsonResponse({ GUID: CASE_ID }),
      jsonResponse({ Waiting: false, Error: 'Sign-in collector threw', Progress: { Status: 'failed', Steps: [] } })
    );

    const promise = svc.becCheck(TENANT, UPN, { intervalMs: 1000, maxAttempts: 2 }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.findings).toBeNull();
    expect(result.recheck?.args.caseId).toBeUndefined();
  });

  it('returns pending with the case id when the poll budget runs out', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(identityLookup())
      .mockResolvedValueOnce(jsonResponse({ GUID: CASE_ID }))
      .mockResolvedValue(jsonResponse({ Waiting: true, Progress: { Status: 'running', Steps: [] } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.becCheck(TENANT, UPN, { intervalMs: 1000, maxAttempts: 2 }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result.status).toBe('pending');
    expect(result.findings).toBeNull();
    expect(result.recheck?.tool).toBe('cipp_bec_check');
    expect(result.recheck?.args.caseId).toBe(CASE_ID);
  });

  it('caseId reads that case immediately and starts nothing', async () => {
    const fetchMock = mockFetch(
      identityLookup(),
      jsonResponse({ ExtractResult: 'Successfully extracted logs from auditlog', Run: { Status: 'Completed' } })
    );

    const result = (await svc.becCheck(TENANT, UPN, { caseId: CASE_ID })) as BecResult;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toContain('GUID=' + CASE_ID);
    expect(result.status).toBe('complete');
  });

  it('useCached reads the latest case without POSTing', async () => {
    const fetchMock = mockFetch(
      identityLookup(),
      jsonResponse({ GUID: CASE_ID, CaseId: CASE_ID, Status: 'Completed' }),
      jsonResponse({ ExtractResult: 'Successfully extracted logs from auditlog', Run: { Status: 'Completed' } })
    );

    const result = (await svc.becCheck(TENANT, UPN, { useCached: true })) as BecResult;

    const methods = fetchMock.mock.calls.map((c) => c[1].method);
    expect(methods).not.toContain('POST');
    expect(fetchMock.mock.calls[1][0]).toContain('userid=' + USER_ID);
    expect(fetchMock.mock.calls[1][0]).not.toContain('GUID=');
    expect(result.caseId).toBe(CASE_ID);
  });

  it('useCached with no prior runs starts a new case', async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetch(
      identityLookup(),
      jsonResponse({ GUID: null, CaseId: null, Status: null, NoRuns: true }),
      jsonResponse({ GUID: CASE_ID }),
      jsonResponse({ ExtractResult: 'Successfully extracted logs from auditlog', Run: { Status: 'Completed' } })
    );

    const promise = svc.becCheck(TENANT, UPN, { useCached: true, intervalMs: 1000 }) as Promise<BecResult>;
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
    expect(result.status).toBe('complete');
  });

  it('cuts lists to sampleSize, drops bulk lists, and strips the evidence zip', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    mockFetch(
      identityLookup(),
      jsonResponse({
        SuspectUserSignIns: many(42),
        NonInteractiveSignIns: many(6128),
        AttackerMailActivity: many(1198),
        NewRules: [],
        Evidence: { CaseId: CASE_ID, ZipBase64: 'UEsDBBQ' + 'A'.repeat(5000) },
        ExtractResult: 'Successfully extracted logs from auditlog',
        Run: { Status: 'Completed' },
      })
    );

    const result = (await svc.becCheck(TENANT, UPN, { caseId: CASE_ID })) as BecResult;
    const f = result.findings as Record<string, unknown[] | Record<string, unknown>>;

    expect((f.SuspectUserSignIns as unknown[]).length).toBe(3);
    expect((f.NonInteractiveSignIns as unknown[]).length).toBe(0);
    expect(result.truncated).toEqual({ SuspectUserSignIns: 42, NonInteractiveSignIns: 6128, AttackerMailActivity: 1198 });
    expect((f.Evidence as Record<string, unknown>).ZipBase64).toBe('<omitted>');
    expect(JSON.stringify(result).length).toBeLessThan(5000);
  });

  it('section pages one list in full', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ i }));
    mockFetch(
      identityLookup(),
      jsonResponse({ NonInteractiveSignIns: many, ExtractResult: 'Successfully extracted', Run: { Status: 'Completed' } })
    );

    const result = (await svc.becCheck(TENANT, UPN, {
      caseId: CASE_ID,
      section: 'NonInteractiveSignIns',
      offset: 200,
      limit: 100,
    })) as BecResult;

    expect(result.findings).toBeNull();
    expect(result.page?.total).toBe(250);
    expect((result.page?.rows as unknown[]).length).toBe(50);
    expect(result.page?.nextOffset).toBeNull();
  });

  it('lists collectors CIPP could not run and honours CIPP\'s High score', async () => {
    mockFetch(
      identityLookup(),
      jsonResponse({
        Score: {
          Value: 9,
          Level: 'High',
          Breakdown: [{ Signal: 'AttackerIPs', Count: 2, Applied: true }],
        },
        Completeness: {
          SignIns: { Complete: true, Skipped: false, Error: null, Requirement: null },
          RiskState: { Complete: false, Skipped: true, Error: null, Requirement: 'Entra ID P2' },
        },
        ExtractResult: 'Successfully extracted logs from auditlog',
        Run: { Status: 'Completed' },
      })
    );

    const result = (await svc.becCheck(TENANT, UPN, { caseId: CASE_ID })) as BecResult;

    expect(result.incompleteChecks).toEqual(['RiskState: Entra ID P2']);
    expect(result.assessment?.severity).toBe('critical');
    expect(result.assessment?.reasons.join(' ')).toMatch(/threat level High/);
  });

  it('uses CIPP\'s IP verdicts: home IP is quiet, attacker IP is critical', async () => {
    mockFetch(
      identityLookup(),
      jsonResponse({
        SuspectUserSignIns: [
          { Status: 'Success', IPAddress: '162.196.25.42', IPVerdict: 'Unknown', ForeignLocation: false },
          { Status: 'Success', IPAddress: '203.0.113.9', IPVerdict: 'LikelyAttacker', ForeignLocation: true },
        ],
        ExtractResult: 'Successfully extracted logs from auditlog',
        Run: { Status: 'Completed' },
      })
    );

    const result = (await svc.becCheck(TENANT, UPN, { caseId: CASE_ID })) as BecResult;

    expect(result.assessment?.severity).toBe('critical');
    const text = result.assessment?.reasons.join(' ') ?? '';
    expect(text).toContain('203.0.113.9');
    expect(text).not.toContain('162.196.25.42');
  });

  it('refuses to run against a user it cannot resolve', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValue(jsonResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.becCheck(TENANT, 'ghost@contoso.com')).rejects.toThrow(/could not resolve user/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
