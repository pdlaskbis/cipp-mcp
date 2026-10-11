// Tests for CippService.rawRequest — the READ-ONLY escape hatch.
//
// Contract:
//  - Only CIPP read Functions (name starts with List / Get / Read) are allowed.
//  - Any mutating Function (Exec*, Add*, Set*, New*, Remove*, Delete*, Edit*,
//    Enable*, Disable*, ...) is refused BEFORE any network call is made.
//  - functionName must be a bare segment: no slash, dot, query string or
//    path traversal, so it can never escape /api/<name>.
//  - GET sends `query` as the query string; POST sends `body` as JSON.

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

describe('CippService.rawRequest', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls a GET read Function and serialises query params', async () => {
    const fetchMock = jest.fn((url: string, _init: RequestInit) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/api/ListDomainHealth');
      expect(u.searchParams.get('Action')).toBe('ReadDkimRecord');
      expect(u.searchParams.get('Domain')).toBe('contoso.com');
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.rawRequest({
      functionName: 'ListDomainHealth',
      query: { Action: 'ReadDkimRecord', Domain: 'contoso.com' },
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('defaults to GET when no method is given', async () => {
    const fetchMock = jest.fn((_url: string, _init: RequestInit) => Promise.resolve(jsonResponse([])));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.rawRequest({ functionName: 'ListDomains' });

    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('sends a JSON body for a POST read Function', async () => {
    const fetchMock = jest.fn((url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/api/ListTenants');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ AllTenantSelector: true });
      return Promise.resolve(jsonResponse([{ defaultDomainName: 'contoso.com' }]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.rawRequest({
      functionName: 'ListTenants',
      method: 'POST',
      body: { AllTenantSelector: true },
    });

    expect(result).toEqual([{ defaultDomainName: 'contoso.com' }]);
  });

  it.each([
    'ExecResetMFA',
    'AddUser',
    'SetDkimSigningConfig',
    'NewDkimSigningConfig',
    'RemoveUser',
    'DeleteGroup',
    'EditUser',
    'ExecDnsConfig',
  ])('refuses the mutating Function %s without any network call', async (fn) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.rawRequest({ functionName: fn })).rejects.toThrow(/READ-ONLY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'ListDomains/../ExecResetMFA',
    'ListDomains?tenantFilter=x',
    'List Domains',
    '../secrets',
    '',
    'List.Domains',
  ])('rejects the unsafe functionName %p before any network call', async (fn) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.rawRequest({ functionName: fn })).rejects.toThrow(/bare CIPP Function name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
