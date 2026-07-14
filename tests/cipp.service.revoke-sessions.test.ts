// Tests for CippService revokeSessions Username payload behavior.
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

describe('CippService revokeSessions', () => {
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

  it("revokeSessions sends Username so CIPP's confirmation is not blank", async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: ['Successfully revoked sessions for alice@contoso.com'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.revokeSessions('contoso.com', 'alice@contoso.com');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/ExecRevokeSessions$/);
    const body = JSON.parse(init.body as string);
    expect(body.Username).toBe('alice@contoso.com');
    expect(body.ID).toBe('alice@contoso.com');
  });

  it('revokeSessions omits Username when given a bare object id and no username', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: ['Successfully revoked sessions for '] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.revokeSessions('contoso.com', '11111111-1111-1111-1111-111111111111');

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.Username).toBeUndefined();
    expect(body.ID).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('revokeSessions prefers an explicit username over the inferred one', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: ['Successfully revoked sessions for alice@contoso.com'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.revokeSessions(
      'contoso.com',
      '11111111-1111-1111-1111-111111111111',
      'alice@contoso.com'
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.Username).toBe('alice@contoso.com');
    expect(body.ID).toBe('11111111-1111-1111-1111-111111111111');
  });
});
