// Tests for cipp_delete_group (CippService.deleteGroup).
//
// Contract grounded in KelvinTegelaar/CIPP-API Invoke-ExecGroupsDelete.ps1 +
// Remove-CIPPGroup.ps1: ExecGroupsDelete reads tenantFilter / id / GroupType /
// displayName and acts ONLY on GroupType 'Microsoft 365' | 'Security' |
// 'Distribution List' | 'Mail-Enabled Security' — anything else returns 200 with
// null Results having deleted nothing. 200 "Successfully Deleted …" on success,
// 500 "Could not delete … Error: …" on failure.
//
// Readback: ListGroups?groupID= (batched) returns 200 with the Graph error as
// groupInfo once the group is gone; ListGraphRequest groups?$filter=id eq '…'
// returns Results: []. Both are required before `verified: true`.
import { CippService, DeleteGroupEnvelope } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const TENANT = 'contoso.com';
const GID = '44444444-4444-4444-4444-444444444444';
const NAME = 'ZZZ-Test-Group';
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
  /** groupInfo while the group exists; null = never existed. */
  group?: Record<string, unknown> | null;
  members?: unknown[];
  roles?: unknown;
  /** Extra rows in the tenant-wide ListGroups (for name resolution). */
  others?: Array<Record<string, unknown>>;
  remove?: { status: number; body: unknown };
  goneAfterDelete?: boolean;
}

function cipp(s: Scenario) {
  const group =
    s.group === undefined
      ? { id: GID, displayName: NAME, groupType: 'Security', onPremisesSyncEnabled: null, assignedLicenses: [], teamsEnabled: false }
      : s.group;
  let deleted = false;
  return jest.fn((rawUrl: string, init: RequestInit) => {
    const url = new URL(String(rawUrl));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const present = group !== null && !deleted;

    if (method === 'GET' && path === '/api/ListGroups') {
      const gid = url.searchParams.get('groupID');
      if (gid) {
        const hit = present && gid.toLowerCase() === String(group!.id).toLowerCase();
        return Promise.resolve(
          response(200, {
            groupInfo: hit ? group : { error: { code: 'Request_ResourceNotFound' }, groupType: null },
            members: hit ? (s.members ?? []) : [],
            owners: [],
          })
        );
      }
      return Promise.resolve(response(200, [...(present ? [group] : []), ...(s.others ?? [])]));
    }
    if (method === 'GET' && path === '/api/ListGraphRequest') {
      return Promise.resolve(response(200, { Results: present ? [{ id: GID }] : [], Metadata: {} }));
    }
    if (method === 'GET' && path === '/api/ListRoles') {
      return Promise.resolve(response(200, s.roles ?? [{ DisplayName: 'Global Administrator', Members: [] }]));
    }
    if (method === 'POST' && path === '/api/ExecGroupsDelete') {
      const r = s.remove ?? { status: 200, body: { Results: `Successfully Deleted Security group ${NAME}` } };
      if (r.status === 200 && s.goneAfterDelete !== false) deleted = true;
      return Promise.resolve(response(r.status, r.body));
    }
    return Promise.reject(new Error(`unexpected call ${method} ${path}`));
  });
}

function deleteCalls(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === 'POST' && String(url).includes('/api/ExecGroupsDelete')
  );
}

describe('CippService.deleteGroup', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });

  afterEach(() => jest.restoreAllMocks());

  // ---- Outbound payload shape --------------------------------------------

  it.each(['Security', 'Microsoft 365', 'Distribution List', 'Mail-Enabled Security'])(
    'sends ExecGroupsDelete the resolved id, the group\'s own GroupType (%s) and displayName',
    async (groupType) => {
      const fetchMock = cipp({
        group: { id: GID, displayName: NAME, groupType, assignedLicenses: [], teamsEnabled: false },
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await svc.deleteGroup(TENANT, GID, false, FAST);

      const calls = deleteCalls(fetchMock);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1].body as string)).toEqual({
        tenantFilter: TENANT,
        id: GID,
        GroupType: groupType,
        displayName: NAME,
      });
    }
  );

  it('resolves a unique display name to the object id', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, NAME.toLowerCase(), false, FAST);

    expect(res.verified).toBe(true);
    expect(JSON.parse(deleteCalls(fetchMock)[0][1].body as string).id).toBe(GID);
  });

  // ---- Guards --------------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['blank', '  '],
  ])('rejects a %s groupId without calling CIPP', async (_l, groupId) => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, groupId as unknown as string)).rejects.toThrow(/groupId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['allTenants', 'AllTenants'])('rejects tenantFilter %s without calling CIPP', async (t) => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(t, GID)).rejects.toThrow(/single-tenant only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a group that does not resolve (by id or by name)', async () => {
    const fetchMock = cipp({ group: null });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, GID)).rejects.toThrow(/not found/);
    await expect(svc.deleteGroup(TENANT, NAME)).rejects.toThrow(/not found/);
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('rejects an ambiguous display name', async () => {
    const fetchMock = cipp({ others: [{ id: '55555555-5555-5555-5555-555555555555', displayName: NAME }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, NAME)).rejects.toThrow(/2 groups are named/);
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it.each([null, 'Dynamic', ''])(
    'refuses a group type CIPP would silently no-op on (%p), even with force',
    async (groupType) => {
      const fetchMock = cipp({ group: { id: GID, displayName: NAME, groupType } });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.deleteGroup(TENANT, GID, true)).rejects.toThrow(/would return success without deleting/);
      expect(deleteCalls(fetchMock)).toHaveLength(0);
    }
  );

  it('refuses an on-prem synced group, even with force', async () => {
    const fetchMock = cipp({
      group: { id: GID, displayName: NAME, groupType: 'Security', onPremisesSyncEnabled: true },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, GID, true)).rejects.toThrow(/synced from on-premises/);
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses a role-holding group, even with force', async () => {
    const fetchMock = cipp({ roles: [{ DisplayName: 'Helpdesk Administrator', Members: [{ id: GID.toUpperCase() }] }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, GID, true)).rejects.toThrow(/Helpdesk Administrator/);
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('refuses when the role read fails', async () => {
    const base = cipp({});
    const fetchMock = jest.fn((url: string, init: RequestInit) =>
      String(url).includes('/api/ListRoles') ? Promise.resolve(response(400, 'nope')) : base(url, init)
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, GID)).rejects.toThrow(/could not confirm it holds no directory role/);
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it.each([
    ['members', { members: [{ id: 'u1' }, { id: 'u2' }] }, /2 member\(s\)/],
    [
      'licenses',
      { group: { id: GID, displayName: NAME, groupType: 'Security', assignedLicenses: [{ skuId: 's' }] } },
      /license/,
    ],
    [
      'a Team',
      { group: { id: GID, displayName: NAME, groupType: 'Microsoft 365', assignedLicenses: [], teamsEnabled: true } },
      /Microsoft Team/,
    ],
  ])('refuses a group with %s unless force', async (_l, scenario, msg) => {
    const fetchMock = cipp(scenario as Scenario);
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.deleteGroup(TENANT, GID)).rejects.toThrow(msg);
    expect(deleteCalls(fetchMock)).toHaveLength(0);

    const res = await svc.deleteGroup(TENANT, GID, true, FAST);
    expect(res.verified).toBe(true);
    expect(deleteCalls(fetchMock)).toHaveLength(1);
  });

  // ---- Verification envelope ----------------------------------------------

  it('verified when the group reads back as not found (Security: permanent)', async () => {
    const fetchMock = cipp({});
    global.fetch = fetchMock as unknown as typeof fetch;

    const res: DeleteGroupEnvelope = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.status).toBe('verified');
    expect(res.verified).toBe(true);
    expect(res.verifiedBy).toBe('groupNotFound');
    expect(res.recheck).toBeNull();
    expect(res.message).toContain(NAME);
    expect(res.message).toContain(GID);
    expect(res.message).toMatch(/NOT restorable/);
    expect(res).toMatchObject({ groupId: GID, displayName: NAME, groupType: 'Security' });
    // Absence is proven by the filtered Graph read, not just the batched by-id read.
    const filtered = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/ListGraphRequest'));
    expect(filtered).toBeDefined();
    const q = new URL(String(filtered![0])).searchParams;
    expect(q.get('Endpoint')).toBe('groups');
    expect(q.get('$filter')).toBe(`id eq '${GID}'`);
  });

  it('M365 group success message says restorable for 30 days', async () => {
    global.fetch = cipp({
      group: { id: GID, displayName: NAME, groupType: 'Microsoft 365', assignedLicenses: [], teamsEnabled: false },
    }) as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.verified).toBe(true);
    expect(res.message).toMatch(/Restorable .* 30 days by object id/);
  });

  it('recheck (never success) when the group is still present at the deadline', async () => {
    global.fetch = cipp({ goneAfterDelete: false }) as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.status).toBe('unverified');
    expect(res.verified).toBe(false);
    expect(res.recheck?.instruction).toMatch(/Re-read the group/);
    expect(res.message).toMatch(/Do NOT report success/);
  });

  it('recheck mentions Exchange lag for a distribution list', async () => {
    global.fetch = cipp({
      group: { id: GID, displayName: NAME, groupType: 'Distribution List', assignedLicenses: [] },
      goneAfterDelete: false,
    }) as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.verified).toBe(false);
    expect(res.recheck?.instruction).toMatch(/Exchange-side deletes/);
  });

  it('not verified when CIPP returns 200 with null Results and the group is still there (the no-op trap)', async () => {
    global.fetch = cipp({ remove: { status: 200, body: { Results: null } }, goneAfterDelete: false }) as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.verified).toBe(false);
    expect(res.status).toBe('unverified');
  });

  it('not verified when the filtered read errors, even though the by-id read misses', async () => {
    const base = cipp({});
    const fetchMock = jest.fn((url: string, init: RequestInit) =>
      String(url).includes('/api/ListGraphRequest') ? Promise.resolve(response(500, 'throttled')) : base(url, init)
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.verified).toBe(false);
  });

  it('failed on HTTP 500, surfacing CIPP Results verbatim', async () => {
    const cippError = `Could not delete ${NAME}. Error: Insufficient privileges to complete the operation.`;
    const fetchMock = cipp({ remove: { status: 500, body: { Results: cippError } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await svc.deleteGroup(TENANT, GID, false, FAST);

    expect(res.status).toBe('failed');
    expect(res.verified).toBe(false);
    expect(res.message).toContain(cippError);
    expect(res.submission).toEqual({ httpStatus: 500, Results: cippError });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/ListGraphRequest'))).toBe(false);
  });
});
