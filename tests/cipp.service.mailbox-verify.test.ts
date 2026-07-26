// Tests for tranche-B mailbox work:
//   - convertMailbox verification envelope (recipientTypeDetails readback)
//   - listMailboxPermissions param fix (CIPP reads userId, not UserPrincipalName)
//
// Contracts verified against KelvinTegelaar/CIPP-API tag 10.7.0:
// Invoke-ListMailboxes.ps1 (returns recipientTypeDetails, accepts Identity) and
// Invoke-ListmailboxPermissions.ps1 (reads $Request.Query.userId).
import { CippService, VerifiedWriteEnvelope } from '../src/services/cipp.service.js';
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

/** GET ListMailboxes returns the next queued row (clamped); other calls ack. */
function router(mailboxRows: Array<Record<string, unknown>>) {
  let getCall = 0;
  return jest.fn((url: string, init: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.includes('/api/ListMailboxes')) {
      const row = mailboxRows[Math.min(getCall, mailboxRows.length - 1)] ?? {};
      getCall++;
      return Promise.resolve(jsonResponse([row]));
    }
    return Promise.resolve(jsonResponse({ Results: ['accepted'] }));
  });
}

function callTo(fetchMock: ReturnType<typeof router>, endpoint: string, method?: string) {
  const call = fetchMock.mock.calls.find(([url, init]) => {
    const m = init?.method ?? 'GET';
    return String(url).includes(endpoint) && (method ? m === method : true);
  });
  if (!call) throw new Error(`no ${method ?? ''} call to ${endpoint}`);
  return { url: String(call[0]), init: call[1] };
}

describe('CippService convertMailbox (verified)', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('verified when recipientTypeDetails reads back as the target type', async () => {
    const fetchMock = router([{ recipientTypeDetails: 'SharedMailbox' }]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = (await svc.convertMailbox(
      'contoso.com',
      'shared@contoso.com',
      'Shared'
    )) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('recipientTypeDetails');
    expect(res.recheck).toBeNull();

    // Write carried ID + MailboxType.
    const write = callTo(fetchMock, 'ExecConvertMailbox', 'POST');
    const body = JSON.parse(write.init.body as string);
    expect(body.ID).toBe('shared@contoso.com');
    expect(body.MailboxType).toBe('Shared');

    // Readback scoped the read to the one mailbox via Identity.
    const read = callTo(fetchMock, 'ListMailboxes', 'GET');
    expect(new URL(read.url).searchParams.get('Identity')).toBe('shared@contoso.com');
  });

  it('unverified + recheck when the type never flips', async () => {
    jest.useFakeTimers();
    global.fetch = router([{ recipientTypeDetails: 'UserMailbox' }]) as unknown as typeof fetch;

    const promise = svc.convertMailbox('contoso.com', 'x@contoso.com', 'Shared') as Promise<
      VerifiedWriteEnvelope
    >;
    await jest.advanceTimersByTimeAsync(61_000);
    const res = await promise;

    expect(res.verified).toBe(false);
    expect(res.status).toBe('unverified');
    expect(res.message).toMatch(/Do NOT report success/);
  });

  it('maps Regular -> UserMailbox for the readback', async () => {
    const fetchMock = router([{ recipientTypeDetails: 'UserMailbox' }]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = (await svc.convertMailbox(
      'contoso.com',
      'user@contoso.com',
      'Regular'
    )) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
  });
});

describe('CippService listMailboxPermissions (param fix)', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends userId (not UserPrincipalName) so CIPP scopes to the mailbox', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse([{ User: 'bob@contoso.com', Permissions: 'FullAccess' }]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listMailboxPermissions('contoso.com', 'alice@contoso.com');

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/api\/ListmailboxPermissions$/);
    expect(url.searchParams.get('userId')).toBe('alice@contoso.com');
    expect(url.searchParams.get('UserPrincipalName')).toBeNull();
  });
});
