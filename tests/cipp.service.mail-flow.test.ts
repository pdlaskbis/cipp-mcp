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

describe('CippService mail flow audit tools', () => {
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

  it('listTransportRules passes id through as a query parameter when supplied', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: [{ Name: 'Rule A' }], Metadata: {} }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listTransportRules('contoso.com', 'rule-guid-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('ListTransportRules');
    expect(calledUrl).toContain('tenantFilter=contoso.com');
    expect(calledUrl).toContain('id=rule-guid-123');
  });

  it('listTransportRules omits the id query parameter when not supplied', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: [], Metadata: {} }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listTransportRules('contoso.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('tenantFilter=contoso.com');
    expect(calledUrl).not.toContain('id=');
  });

  it('listExchangeConnectors preserves the bare-array response (no Results envelope)', async () => {
    const bareArray = [
      { Name: 'Outbound to partner', cippconnectortype: 'outbound' },
      { Name: 'Inbound from vendor', cippconnectortype: 'Inbound' },
    ];
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse(bareArray))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listExchangeConnectors('contoso.com')) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result).toEqual(bareArray);
  });
});
