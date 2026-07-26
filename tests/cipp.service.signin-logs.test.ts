// Tests for CippService listSignIns outbound-query SHAPE.
//
// Contract verified against KelvinTegelaar/CIPP-API tag 10.7.0,
// Invoke-ListSignIns.ps1: a GET whose query CIPP maps onto a Graph
// /auditLogs/signIns request. These lock down the casing CIPP actually reads
// (Days / FailureThreshold / Filter) and the semantics that bite silently — a
// raw `filter` replaces the default predicate, and failureThreshold only
// applies alongside failedLogonsOnly.
import { CippService } from '../src/services/cipp.service.js';
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

describe('CippService listSignIns', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetch(payload: unknown) {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse(payload))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function queryOf(fetchMock: ReturnType<typeof mockFetch>): URLSearchParams {
    const [url] = fetchMock.mock.calls[0];
    return new URL(url).searchParams;
  }

  it('GETs /api/ListSignIns with tenantFilter and no request body', async () => {
    const fetchMock = mockFetch([]);

    await svc.listSignIns('contoso.com');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/ListSignIns(\?|$)/);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new URL(url).searchParams.get('tenantFilter')).toBe('contoso.com');
  });

  it('maps days -> Days and failureThreshold -> FailureThreshold (exact CIPP casing)', async () => {
    const fetchMock = mockFetch([]);

    await svc.listSignIns('contoso.com', {
      days: 3,
      failedLogonsOnly: true,
      failureThreshold: 5,
    });

    const q = queryOf(fetchMock);
    expect(q.get('Days')).toBe('3');
    expect(q.get('failedLogonsOnly')).toBe('true');
    expect(q.get('FailureThreshold')).toBe('5');
    // lower-cased variants must NOT be present — CIPP reads the exact casing.
    expect(q.get('days')).toBeNull();
    expect(q.get('failureThreshold')).toBeNull();
  });

  it('passes a raw OData filter through as Filter, verbatim', async () => {
    const fetchMock = mockFetch([]);

    const odata = "appDisplayName eq 'Azure Resource Manager' and status/errorCode ne 0";
    await svc.listSignIns('contoso.com', { filter: odata });

    const q = queryOf(fetchMock);
    expect(q.get('Filter')).toBe(odata);
  });

  it('omits every optional query param when none are supplied', async () => {
    const fetchMock = mockFetch([]);

    await svc.listSignIns('contoso.com');

    const q = queryOf(fetchMock);
    expect(q.get('Days')).toBeNull();
    expect(q.get('failedLogonsOnly')).toBeNull();
    expect(q.get('FailureThreshold')).toBeNull();
    expect(q.get('Filter')).toBeNull();
    // Only tenantFilter rides along.
    expect([...q.keys()]).toEqual(['tenantFilter']);
  });

  it('returns the sign-in rows the API produced', async () => {
    mockFetch([
      { userPrincipalName: 'alice@contoso.com', errorCode: 50126, locationcipp: 'Reno - US' },
      { userPrincipalName: 'bob@contoso.com', errorCode: 0, locationcipp: 'Reno - US' },
    ]);

    const rows = (await svc.listSignIns('contoso.com')) as Array<{ userPrincipalName: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].userPrincipalName).toBe('alice@contoso.com');
  });
});
