// Tests for CippService listGroups payload behavior and client-side filtering.
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

describe('CippService listGroups', () => {
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

  it('listGroups does not send search to CIPP and filters client-side by displayName', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () =>
        Promise.resolve(
          jsonResponse([
            { id: '1', displayName: 'Sales Team' },
            { id: '2', displayName: 'zzz-legatus-prod' },
            { id: '3', displayName: 'HR Team' },
          ])
        )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listGroups('contoso.com', {
      search: 'ZZZ-Legatus',
    })) as Array<{ id: string; displayName: string }>;

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListGroups$/);
    expect(init.method).toBe('GET');
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
    expect(parsed.searchParams.has('search')).toBe(false);
    expect(result).toEqual([
      expect.objectContaining({ id: '2', displayName: 'zzz-legatus-prod' }),
    ]);
  });

  it('listGroups passes UseReportDB flag when requested', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listGroups('contoso.com', { useReportDB: true });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('UseReportDB')).toBe('true');
  });
});
