// Tests for cipp_delete_user (CippService.deleteUser).
//
// Contract grounded in KelvinTegelaar/CIPP-API Invoke-RemoveUser.ps1 +
// Remove-CIPPUser.ps1: RemoveUser reads tenantFilter / ID / userPrincipalName,
// runs Graph DELETE /beta/users/{ID} synchronously, and returns 200 + "Successfully
// deleted user …" or 500 + "Failed to delete user … Error: …". A missing ID returns
// nothing at all, so every guard here runs client-side BEFORE the call.
//
// Readback: a deleted user's by-id ListUsers read errors (Graph 404 surfaces as an
// unhandled 500), and the `graphFilter=id eq '…'` list read returns []. Both are
// required before `verified: true`.
import {
  CippService,
  DeleteUserEnvelope,
  DELETE_USER_DENYLIST_ENV,
} from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const TENANT = 'contoso.com';
const ID = '22222222-2222-2222-2222-222222222222';
const UPN = 'leaver@contoso.com';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const FAST = { timeoutMs: 50, intervalMs: 5 };

function response(status: number, payload: unknown): Response {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

interface Scenario {
  /** The user row the by-id read returns while the user exists. */
  user?: Record<string, unknown> | null;
  /** Roles returned by ListRoles. */
  roles?: unknown;
  /** Groups returned by ListUserGroups. */
  groups?: unknown;
  /** RemoveUser response. */
  remove?: { status: number; body: unknown };
  /** Whether the user still exists after RemoveUser returns. */
  goneAfterDelete?: boolean;
}

/** Route fetch by CIPP endpoint, modelling Graph state before/after the delete. */
function cipp(s: Scenario) {
  const user = s.user === undefined ? { id: ID, userPrincipalName: UPN, accountEnabled: false } : s.user;
  let deleted = false;
  return jest.fn((rawUrl: string, init: RequestInit) => {
    const url = new URL(String(rawUrl));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const present = user !== null && !deleted;

    if (method === 'GET' && path === '/api/ListUsers') {
      const userId = url.searchParams.get('UserID');
      const filter = url.searchParams.get('graphFilter');
      if (userId) {
        return Promise.resolve(
          present && userId.toLowerCase() === String(user!.id).toLowerCase()
            ? response(200, [user])
            : response(500, { error: 'Request_ResourceNotFound' })
        );
      }
      if (filter?.startsWith('id eq ')) return Promise.resolve(response(200, present ? [user] : []));
      if (filter?.startsWith('userPrincipalName eq ')) {
        return Promise.resolve(response(200, present ? [user] : []));
      }
      return Promise.resolve(response(200, present ? [user] : []));
    }
    if (method === 'GET' && path === '/api/ListRoles') {
      return Promise.resolve(response(200, s.roles ?? [{ DisplayName: 'Global Administrator', Members: [] }]));
    }
    if (method === 'GET' && path === '/api/ListUserGroups') {
      return Promise.resolve(response(200, s.groups ?? []));
    }
    if (method === 'POST' && path === '/api/RemoveUser') {
      const r = s.remove ?? {
        status: 200,
        body: { Results: `Successfully deleted user with ID: '${ID}' and Username: '${UPN}'` },
      };
      if (r.status === 200 && s.goneAfterDelete !== false) deleted = true;
      return Promise.resolve(response(r.status, r.body));
    }
    return Promise.reject(new Error(`unexpected call ${method} ${path}`));
  });
}

function removeCalls(fetchMock: ReturnType<typeof cipp>) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === 'POST' && String(url).includes('/api/RemoveUser')
  );
}

describe('CippService.deleteUser', () => {
  let svc: CippService;
  const savedEnv = process.env[DELETE_USER_DENYLIST_ENV];

  beforeEach(() => {
    process.env[DELETE_USER_DENYLIST_ENV] = 'protected-admin@contoso.com, other@contoso.com';
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedEnv === undefined) delete process.env[DELETE_USER_DENYLIST_ENV];
    else process.env[DELETE_USER_DENYLIST_ENV] = savedEnv;
  });

  // ---- Outbound payload shape --------------------------------------------

  it('sends RemoveUser the resolved object id as ID, the resolved UPN, and tenantFilter', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.deleteUser(TENANT, UPN, false, FAST);

    const calls = removeCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({
      tenantFilter: TENANT,
      ID: ID,
      userPrincipalName: UPN,
    });
  });

  it('resolves an object id input to the UPN for the payload', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.deleteUser(TENANT, ID, false, FAST);

    const body = JSON.parse(removeCalls(fetchMock)[0][1].body as string);
    expect(body.ID).toBe(ID);
    expect(body.userPrincipalName).toBe(UPN);
  });

  it('allows guests (#EXT#)', async () => {
    const guest = 'someone_gmail.com#EXT#@contoso.onmicrosoft.com';
    const fetchMock = cipp({ user: { id: ID, userPrincipalName: guest, accountEnabled: false } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteUser(TENANT, ID, false, FAST);

    expect(res.verified).toBe(true);
    expect(JSON.parse(removeCalls(fetchMock)[0][1].body as string).userPrincipalName).toBe(guest);
  });

  // ---- Guards --------------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['blank', '   '],
  ])('rejects a %s userId without calling CIPP', async (_label, userId) => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, userId as unknown as string)).rejects.toThrow(/userId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['allTenants', 'AllTenants'])('rejects tenantFilter %s without calling CIPP', async (t) => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(t, UPN)).rejects.toThrow(/single-tenant only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a user that does not resolve, without calling RemoveUser', async () => {
    const fetchMock = cipp({ user: null });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, ID)).rejects.toThrow(/not found/);
    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/not found/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses an enabled account without force', async () => {
    const fetchMock = cipp({ user: { id: ID, userPrincipalName: UPN, accountEnabled: true } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/account is enabled.*force: true/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it('treats an unreadable accountEnabled as enabled', async () => {
    const fetchMock = cipp({ user: { id: ID, userPrincipalName: UPN } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/unknown enabled state/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it('deletes an enabled account when force is true', async () => {
    const fetchMock = cipp({ user: { id: ID, userPrincipalName: UPN, accountEnabled: true } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteUser(TENANT, UPN, true, FAST);

    expect(res.verified).toBe(true);
    expect(removeCalls(fetchMock)).toHaveLength(1);
  });

  it('refuses a denylisted UPN even with force, before any lookup', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, 'Protected-Admin@contoso.com', true)).rejects.toThrow(
      /hard denylist/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a denylisted account addressed by object id (checks the resolved UPN)', async () => {
    const fetchMock = cipp({
      user: { id: ID, userPrincipalName: 'protected-admin@contoso.com', accountEnabled: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, ID, true)).rejects.toThrow(/hard denylist/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it.each(['breakglass@contoso.com', 'BreakGlass-02@contoso.com'])(
    'refuses break-glass account %s',
    async (upn) => {
      const fetchMock = cipp({ user: { id: ID, userPrincipalName: upn, accountEnabled: false } });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.deleteUser(TENANT, upn, true)).rejects.toThrow(/break-glass/);
      await expect(svc.deleteUser(TENANT, ID, true)).rejects.toThrow(/break-glass/);
      expect(removeCalls(fetchMock)).toHaveLength(0);
    }
  );

  it('refuses every delete when the denylist is not configured', async () => {
    delete process.env[DELETE_USER_DENYLIST_ENV];
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a user holding a directory role directly', async () => {
    const fetchMock = cipp({
      roles: [{ DisplayName: 'Exchange Administrator', Members: [{ id: ID.toUpperCase() }] }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/Exchange Administrator/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses a user holding a directory role through a role-assignable group', async () => {
    const fetchMock = cipp({
      roles: [{ DisplayName: 'Helpdesk Administrator', Members: [{ id: GROUP_ID }] }],
      groups: [{ id: GROUP_ID, DisplayName: 'Helpdesk Admins', IsAssignableToRole: true }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/Helpdesk Administrator/);
    expect(removeCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses when the role read fails (cannot prove non-admin)', async () => {
    const base = cipp({});
    const fetchMock = jest.fn((url: string, init: RequestInit) =>
      String(url).includes('/api/ListRoles')
        ? Promise.resolve(response(400, 'Failed to list roles'))
        : base(url, init)
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteUser(TENANT, UPN)).rejects.toThrow(/could not confirm it holds no directory role/);
    expect(
      fetchMock.mock.calls.filter(([u, i]) => (i?.method ?? 'GET') === 'POST' && String(u).includes('RemoveUser'))
    ).toHaveLength(0);
  });

  // ---- Verification envelope ----------------------------------------------

  it('verified when the user reads back as not found', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    const res: DeleteUserEnvelope = await svc.deleteUser(TENANT, UPN, false, FAST);

    expect(res.status).toBe('verified');
    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('userNotFound');
    expect(res.recheck).toBeNull();
    expect(res.message).toContain(UPN);
    expect(res.message).toContain(ID);
    expect(res.userId).toBe(ID);
    expect(res.userPrincipalName).toBe(UPN);
    expect(res.submission).toEqual({ Results: expect.stringContaining('Successfully deleted') });
    // Absence is proven by the filtered list read, not just a failing by-id read.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('graphFilter=id+eq'))).toBe(true);
  });

  it('recheck (never success) when the user is still present at the deadline', async () => {
    global.fetch = cipp({ goneAfterDelete: false }) as unknown as typeof fetch;

    const res = await svc.deleteUser(TENANT, UPN, false, FAST);

    expect(res.status).toBe('unverified');
    expect(res.verified).toBe(false);
    expect(res.recheck?.instruction).toMatch(/Re-read the user/);
    expect(res.message).toMatch(/Do NOT report success/);
    expect(res.message).not.toMatch(/^Deleted/);
  });

  it('not verified when the by-id read errors but the filtered read still finds the user', async () => {
    const base = cipp({ goneAfterDelete: false });
    let deleted = false;
    const fetchMock = jest.fn((url: string, init: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? 'GET') === 'POST') deleted = true;
      if (deleted && u.includes('UserID=')) return Promise.resolve(response(500, { error: 'transient' }));
      return base(url, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteUser(TENANT, UPN, false, FAST);

    expect(res.verified).toBe(false);
    expect(res.status).toBe('unverified');
  });

  it('failed on HTTP 500, surfacing CIPP Results verbatim', async () => {
    const cippError = `Failed to delete user with ID: '${ID}'. Error: Insufficient privileges to complete the operation. and Username: '${UPN}'`;
    const fetchMock = cipp({ remove: { status: 500, body: { Results: cippError } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteUser(TENANT, UPN, false, FAST);

    expect(res.status).toBe('failed');
    expect(res.verified).toBe(false);
    expect(res.message).toContain(cippError);
    expect(res.submission).toEqual({ httpStatus: 500, Results: cippError });
    // A failed delete is not polled: there is nothing to confirm gone.
    const readsAfter = fetchMock.mock.calls.filter(([u]) => String(u).includes("graphFilter=id+eq"));
    expect(readsAfter).toHaveLength(0);
  });
});
