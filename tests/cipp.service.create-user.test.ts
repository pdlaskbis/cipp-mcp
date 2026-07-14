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

describe('CippService createUser readback verification', () => {
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

  it('createUser reports created only after reading the user back', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/AddUser')) {
        return Promise.resolve(jsonResponse({ Results: 'Queued for creation' }));
      }
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([{ id: 'u1', userPrincipalName: 'alice@contoso.com' }]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.createUser('contoso.com', {
      displayName: 'Alice Smith',
      userPrincipalName: 'alice@contoso.com',
      password: 'Sup3rSecret!',
    })) as { status: string; verified: boolean };

    expect(result.status).toBe('created');
    expect(result.verified).toBe(true);
  });

  it('createUser reports pending - NOT created - when the account never lands', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/AddUser')) {
        return Promise.resolve(jsonResponse({ Results: 'Queued for creation' }));
      }
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = svc.createUser('contoso.com', {
      displayName: 'Alice Smith',
      userPrincipalName: 'alice@contoso.com',
      password: 'Sup3rSecret!',
    }) as Promise<{ status: string; verified: boolean; message: string }>;

    await jest.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result.status).toBe('pending');
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/Do NOT report success/i);
  });

  it('createUser matching is case-insensitive for userPrincipalName readback', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/AddUser')) {
        return Promise.resolve(jsonResponse({ Results: 'Queued for creation' }));
      }
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([{ id: 'u1', userPrincipalName: 'Alice@Contoso.com' }]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.createUser('contoso.com', {
      displayName: 'Alice Smith',
      userPrincipalName: 'alice@contoso.com',
      password: 'Sup3rSecret!',
    })) as { status: string; verified: boolean };

    expect(result.status).toBe('created');
    expect(result.verified).toBe(true);
  });
});
