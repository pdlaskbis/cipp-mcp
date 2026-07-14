// Tests for CippService listEnterpriseApps — the per-tenant servicePrincipals
// audit tool that powers the data-driven catalog candidate ranking.
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

describe('CippService enterprise apps tooling', () => {
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

  it('listEnterpriseApps GETs ListGraphRequest with tenantFilter + /servicePrincipals endpoint and filters built-ins client-side by default', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () =>
        Promise.resolve(
          jsonResponse({
            Results: [
              {
                appId: 'a1',
                displayName: 'Slack',
                appOwnerOrganizationId: '11111111-1111-1111-1111-111111111111',
              },
              {
                appId: 'a2',
                displayName: 'Microsoft App',
                appOwnerOrganizationId: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
              },
            ],
          })
        )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listEnterpriseApps('contoso.com')) as {
      Results: Array<{ appId: string; displayName: string }>;
    };

    expect(result.Results).toEqual([
      expect.objectContaining({ appId: 'a1', displayName: 'Slack' }),
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListGraphRequest$/);
    expect(init.method).toBe('GET');
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
    expect(parsed.searchParams.get('Endpoint')).toBe('/servicePrincipals');
    expect(parsed.searchParams.get('$select')).toBe(
      'appId,displayName,publisherName,appOwnerOrganizationId,signInAudience,tags,createdDateTime'
    );
    expect(parsed.searchParams.has('$filter')).toBe(false);
  });

  it('listEnterpriseApps keeps built-ins when includeBuiltIn=true', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () =>
        Promise.resolve(
          jsonResponse({
            Results: [
              {
                appId: 'a1',
                displayName: 'Slack',
                appOwnerOrganizationId: '11111111-1111-1111-1111-111111111111',
              },
              {
                appId: 'a2',
                displayName: 'Microsoft App',
                appOwnerOrganizationId: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
              },
            ],
          })
        )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listEnterpriseApps('contoso.com', {
      includeBuiltIn: true,
    })) as { Results: Array<{ appId: string; displayName: string }> };

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.has('$filter')).toBe(false);
    expect(parsed.searchParams.get('Endpoint')).toBe('/servicePrincipals');
    expect(result.Results).toEqual([
      expect.objectContaining({ appId: 'a1', displayName: 'Slack' }),
      expect.objectContaining({ appId: 'a2', displayName: 'Microsoft App' }),
    ]);
  });

  it('listEnterpriseApps passes tenantFilter=allTenants through for CIPP-side fan-out', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([{ Tenant: 'contoso.com', appId: 'a1' }]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.listEnterpriseApps('allTenants');

    expect(result).toEqual([{ Tenant: 'contoso.com', appId: 'a1' }]);
    const [url] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get('tenantFilter')).toBe('allTenants');
  });

  it('listEnterpriseApps surfaces an inline error row from CIPP for a tenant 403 without throwing', async () => {
    // CIPP's allTenants fan-out behavior: per-tenant errors are returned as inline
    // entries in the result array, NOT as an HTTP error. The pass-through preserves that shape.
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(
        jsonResponse([
          { Tenant: 'contoso.com', appId: 'a1', displayName: 'Slack' },
          { Tenant: 'fabrikam.com', error: 'Forbidden — GDAP not granted' },
        ])
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listEnterpriseApps('allTenants')) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(2);
    expect(result[0].Tenant).toBe('contoso.com');
    expect(result[1].error).toBe('Forbidden — GDAP not granted');
  });
});
