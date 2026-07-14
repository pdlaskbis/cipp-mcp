// Tests for CippService createGroup payload shaping and client-side validation.
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

describe('CippService createGroup', () => {
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

  it('createGroup always sends groupType (CIPP 500s without it)', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: ['Successfully created group Test'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.createGroup('contoso.com', { displayName: 'Test', groupType: 'Generic' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/AddGroup$/);
    const body = JSON.parse(init.body as string);
    expect(body.groupType).toBe('Generic');
    // CIPP derives these itself; sending Graph-style booleans is meaningless.
    expect(body.securityEnabled).toBeUndefined();
    expect(body.mailEnabled).toBeUndefined();
  });

  it('createGroup rejects a mail-enabled type with no username, before calling CIPP', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createGroup('contoso.com', { displayName: 'Finance', groupType: 'M365' })
    ).rejects.toThrow(/username/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createGroup wraps primDomain as { value } the way CIPP reads it', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: ['Successfully created group Finance'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.createGroup('contoso.com', {
      displayName: 'Finance',
      groupType: 'Distribution',
      username: 'finance-team',
      primDomain: 'contoso.com',
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.primDomain).toEqual({ value: 'contoso.com' });
    expect(body.username).toBe('finance-team');
  });
});
