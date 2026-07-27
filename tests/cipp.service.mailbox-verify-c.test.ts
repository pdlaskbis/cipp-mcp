// Tranche-C verification envelopes: editMailboxPermissions and setEmailForwarding.
//
// Readback shapes verified LIVE 2026-07-26 against askbis.com and against
// KelvinTegelaar/CIPP-API tag 10.7.0 (Invoke-ListmailboxPermissions.ps1 returns
// { User, Permissions:string|array }; Invoke-ListMailboxes.ps1 returns
// ForwardingSmtpAddress / InternalForwardingAddress and accepts an Identity).
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

/** Route by endpoint. `permissions`/`mailboxes` are queued (clamped to last). */
function router(cfg: {
  permissions?: Array<Record<string, unknown>>;
  mailboxes?: Array<Record<string, unknown>>;
  domains?: Array<Record<string, unknown>>;
}) {
  return jest.fn((url: string, init: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.includes('/api/ListmailboxPermissions')) {
      // The read returns the FULL permission list on every call.
      return Promise.resolve(jsonResponse(cfg.permissions ?? []));
    }
    if (method === 'GET' && u.includes('/api/ListMailboxes')) {
      // Identity-scoped read returns a single mailbox row.
      return Promise.resolve(jsonResponse([(cfg.mailboxes ?? [{}])[0] ?? {}]));
    }
    if (method === 'GET' && u.includes('/api/ListDomains')) {
      return Promise.resolve(jsonResponse(cfg.domains ?? []));
    }
    return Promise.resolve(jsonResponse({ Results: ['accepted'] }));
  });
}

describe('CippService editMailboxPermissions (verified)', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('verified when the granted delegate appears with the permission', async () => {
    // Permissions returned as a STRING, alongside an ignored NT AUTHORITY\SELF row.
    global.fetch = router({
      permissions: [
        { User: 'NT AUTHORITY\\SELF', Permissions: 'FullAccess, ReadPermission' },
        { User: 'bob@contoso.com', Permissions: 'FullAccess' },
      ],
    }) as unknown as typeof fetch;

    const res = (await svc.editMailboxPermissions('contoso.com', 'alice@contoso.com', {
      AddFullAccess: ['bob@contoso.com'],
    })) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('mailboxPermissions');
  });

  it('handles SendAs returned as an array', async () => {
    global.fetch = router({
      permissions: [{ User: 'bob@contoso.com', Permissions: ['SendAs'] }],
    }) as unknown as typeof fetch;

    const res = (await svc.editMailboxPermissions('contoso.com', 'alice@contoso.com', {
      AddSendAs: ['bob@contoso.com'],
    })) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
  });

  it('verified for a removal when the delegate is absent', async () => {
    global.fetch = router({
      permissions: [{ User: 'NT AUTHORITY\\SELF', Permissions: 'FullAccess, ReadPermission' }],
    }) as unknown as typeof fetch;

    const res = (await svc.editMailboxPermissions('contoso.com', 'alice@contoso.com', {
      RemoveFullAccess: ['bob@contoso.com'],
    })) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
  });

  it('unverified + recheck when the grant never appears', async () => {
    jest.useFakeTimers();
    global.fetch = router({
      permissions: [{ User: 'NT AUTHORITY\\SELF', Permissions: 'FullAccess, ReadPermission' }],
    }) as unknown as typeof fetch;

    const p = svc.editMailboxPermissions('contoso.com', 'alice@contoso.com', {
      AddFullAccess: ['bob@contoso.com'],
    }) as Promise<VerifiedWriteEnvelope>;
    await jest.advanceTimersByTimeAsync(61_000);
    const res = await p;

    expect(res.verified).toBe(false);
    expect(res.message).toMatch(/Do NOT report success/);
  });
});

describe('CippService setEmailForwarding (verified)', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('external forward verified when ForwardingSmtpAddress matches', async () => {
    global.fetch = router({
      domains: [{ id: 'contoso.com' }], // ext.example is NOT internal
      mailboxes: [{ ForwardingSmtpAddress: 'boss@ext.example' }],
    }) as unknown as typeof fetch;

    const res = (await svc.setEmailForwarding('contoso.com', 'alice@contoso.com', {
      forwardTo: 'boss@ext.example',
    })) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('ForwardingSmtpAddress');
  });

  it('disable verified when no forwarding address remains', async () => {
    global.fetch = router({
      mailboxes: [{ ForwardingSmtpAddress: '', InternalForwardingAddress: '' }],
    }) as unknown as typeof fetch;

    const res = (await svc.setEmailForwarding('contoso.com', 'alice@contoso.com', {})) as
      VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
  });

  it('unverified when the forward is not reflected on the mailbox', async () => {
    jest.useFakeTimers();
    global.fetch = router({
      domains: [{ id: 'contoso.com' }],
      mailboxes: [{ ForwardingSmtpAddress: '' }], // never set
    }) as unknown as typeof fetch;

    const p = svc.setEmailForwarding('contoso.com', 'alice@contoso.com', {
      forwardTo: 'boss@ext.example',
    }) as Promise<VerifiedWriteEnvelope>;
    await jest.advanceTimersByTimeAsync(46_000);
    const res = await p;

    expect(res.verified).toBe(false);
    expect(res.message).toMatch(/Do NOT report success/);
  });
});
