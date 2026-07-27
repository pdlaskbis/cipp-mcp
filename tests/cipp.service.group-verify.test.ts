// Tranche-C verification envelope: editGroupMembers.
//
// Readback confirmed from the MEMBER's side. Verified against
// KelvinTegelaar/CIPP-API tag 10.7.0, Invoke-ListUserGroups.ps1: it returns a
// user's group memberships, each carrying the group's object `id`.
import { CippService, VerifiedWriteEnvelope } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const GUID = '22222222-2222-2222-2222-222222222222';

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function router(cfg: { groups?: Array<Record<string, unknown>> }) {
  return jest.fn((url: string, init: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.includes('/api/ListUserGroups')) {
      return Promise.resolve(jsonResponse(cfg.groups ?? []));
    }
    if (method === 'GET' && u.includes('/api/ListUsers')) {
      return Promise.resolve(jsonResponse([{ id: GUID, userPrincipalName: 'x@contoso.com' }]));
    }
    return Promise.resolve(jsonResponse({ Results: ['done'] }));
  });
}

describe('CippService editGroupMembers (verified)', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('add verified when the member now lists the group', async () => {
    global.fetch = router({ groups: [{ id: 'group-1', DisplayName: 'Team' }] }) as unknown as typeof fetch;

    const res = (await svc.editGroupMembers('contoso.com', 'group-1', 'security', [
      'bob@contoso.com',
    ])) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('groupMembership');
  });

  it('add unverified + recheck when the group never appears for the member', async () => {
    jest.useFakeTimers();
    global.fetch = router({ groups: [{ id: 'some-other-group' }] }) as unknown as typeof fetch;

    const p = svc.editGroupMembers('contoso.com', 'group-1', 'security', ['bob@contoso.com']) as
      Promise<VerifiedWriteEnvelope>;
    await jest.advanceTimersByTimeAsync(46_000);
    const res = await p;

    expect(res.verified).toBe(false);
    expect(res.message).toMatch(/Do NOT report success/);
  });

  it('remove verified when the member no longer lists the group', async () => {
    global.fetch = router({ groups: [{ id: 'some-other-group' }] }) as unknown as typeof fetch;

    const res = (await svc.editGroupMembers(
      'contoso.com',
      'group-1',
      'security',
      undefined,
      [GUID]
    )) as VerifiedWriteEnvelope;

    expect(res.verified).toBe(true);
  });
});
