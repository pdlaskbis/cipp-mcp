// Deliverable 3: setPerUserMFA, listGroupMembers, execGDAPInvite.
//
// Request/response shapes for ExecPerUserMFA, ListPerUserMFA, ListGroups
// (members=true) and ExecGDAPInvite are UNVERIFIED against upstream CIPP-API —
// these tests pin the shapes cipp-mcp currently sends/parses.
import {
  CippService,
  GdapInviteResult,
  GroupMembersResult,
  VerifiedWriteEnvelope,
} from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const GUID = '33333333-3333-3333-3333-333333333333';
const GA_ROLE = '62e90394-69f5-4237-9190-012177145e10';
const HD_ROLE = '729827e3-9c14-49f7-bb1b-9608f156bbb8';

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

type Handler = (url: string, init: RequestInit) => unknown;

function router(routes: Record<string, Handler>) {
  return jest.fn((url: string, init: RequestInit) => {
    const u = String(url);
    for (const [key, h] of Object.entries(routes)) {
      if (u.includes(`/api/${key}?`) || u.endsWith(`/api/${key}`)) {
        return Promise.resolve(jsonResponse(h(u, init)));
      }
    }
    return Promise.reject(new Error(`unexpected ${u}`));
  });
}

function bodyOf(fetchMock: jest.Mock, endpoint: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes(`/api/${endpoint}`));
  if (!call) throw new Error(`${endpoint} not called`);
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('Deliverable 3 tools', () => {
  let svc: CippService;
  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'k' } }, logger);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  describe('setPerUserMFA', () => {
    it('sends tenantFilter/userId/userPrincipalName/State and verifies via ListPerUserMFA', async () => {
      const fetchMock = router({
        ListUsers: () => [{ id: GUID, userPrincipalName: 'alice@contoso.com' }],
        ExecPerUserMFA: () => ({ Results: ['Successfully set Per user MFA State'] }),
        ListPerUserMFA: () => [{ PerUserMFAState: 'enforced', UserPrincipalName: GUID }],
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const res = (await svc.setPerUserMFA('contoso.com', 'alice@contoso.com', 'enforced')) as VerifiedWriteEnvelope;

      expect(bodyOf(fetchMock, 'ExecPerUserMFA')).toEqual({
        tenantFilter: 'contoso.com',
        userId: GUID,
        userPrincipalName: 'alice@contoso.com',
        State: 'enforced',
      });
      expect(res.verified).toBe(true);
      expect(res.verifiedBy).toBe('perUserMfaState');
      const readUrl = fetchMock.mock.calls
        .map(([u]) => String(u))
        .find((u) => u.includes('/api/ListPerUserMFA'))!;
      expect(readUrl).toContain(`userId=${GUID}`);
    });

    it('resolves the UPN when given an object id', async () => {
      const fetchMock = router({
        ListUsers: () => [{ id: GUID, userPrincipalName: 'bob@contoso.com' }],
        ExecPerUserMFA: () => ({ Results: ['ok'] }),
        ListPerUserMFA: () => [{ PerUserMFAState: 'disabled' }],
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const res = (await svc.setPerUserMFA('contoso.com', GUID, 'disabled')) as VerifiedWriteEnvelope;
      expect(bodyOf(fetchMock, 'ExecPerUserMFA').userPrincipalName).toBe('bob@contoso.com');
      expect(res.verified).toBe(true);
    });

    it('stays unverified with a recheck when the state never changes', async () => {
      jest.useFakeTimers();
      global.fetch = router({
        ListUsers: () => [{ id: GUID, userPrincipalName: 'alice@contoso.com' }],
        ExecPerUserMFA: () => ({ Results: ['Successfully set Per user MFA State'] }),
        ListPerUserMFA: () => [{ PerUserMFAState: 'disabled' }],
      }) as unknown as typeof fetch;

      const p = svc.setPerUserMFA('contoso.com', 'alice@contoso.com', 'enforced') as Promise<VerifiedWriteEnvelope>;
      await jest.advanceTimersByTimeAsync(31_000);
      const res = await p;
      expect(res.verified).toBe(false);
      expect(res.recheck).not.toBeNull();
      expect(res.message).toMatch(/Do NOT report success/);
    });

    it('rejects an invalid state before calling CIPP', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(
        svc.setPerUserMFA('contoso.com', 'alice@contoso.com', 'on' as never)
      ).rejects.toThrow(/state must be one of/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('listGroupMembers', () => {
    it('calls ListGroups with groupID + members=true and shapes members', async () => {
      const fetchMock = router({
        ListGroups: () => ({
          groupInfo: { id: 'g1', displayName: 'Avanan Protected' },
          members: [
            { '@odata.type': '#microsoft.graph.user', id: 'u1', displayName: 'Alice', userPrincipalName: 'alice@contoso.com', mail: 'alice@contoso.com' },
            { '@odata.type': '#microsoft.graph.group', id: 'g2', displayName: 'Nested' },
          ],
          owners: [],
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const res: GroupMembersResult = await svc.listGroupMembers('contoso.com', { groupId: 'g1' });

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('groupID=g1');
      expect(url).toContain('members=true');
      expect(res.groupName).toBe('Avanan Protected');
      expect(res.memberCount).toBe(2);
      expect(res.members[0]).toEqual({
        id: 'u1',
        displayName: 'Alice',
        userPrincipalName: 'alice@contoso.com',
        mail: 'alice@contoso.com',
        type: 'user',
      });
      expect(res.members[1].type).toBe('group');
    });

    it('resolves groupName to an id first', async () => {
      const fetchMock = jest.fn((url: string) => {
        const u = String(url);
        if (u.includes('groupID=')) {
          return Promise.resolve(jsonResponse({ groupInfo: { displayName: 'Avanan' }, members: [{ id: 'u1' }] }));
        }
        return Promise.resolve(jsonResponse([{ id: 'g9', displayName: 'Avanan' }, { id: 'g8', displayName: 'Avanan Admins' }]));
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const res = await svc.listGroupMembers('contoso.com', { groupName: 'avanan' });
      expect(res.groupId).toBe('g9');
      expect(String(fetchMock.mock.calls[1][0])).toContain('groupID=g9');
      expect(res.memberCount).toBe(1);
    });

    it('errors on an ambiguous groupName', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve(jsonResponse([{ id: 'a', displayName: 'Dup' }, { id: 'b', displayName: 'dup' }]))
      ) as unknown as typeof fetch;
      await expect(svc.listGroupMembers('contoso.com', { groupName: 'Dup' })).rejects.toThrow(/2 groups/);
    });

    it('requires groupId or groupName', async () => {
      await expect(svc.listGroupMembers('contoso.com', {})).rejects.toThrow(/groupId or groupName/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('execGDAPInvite', () => {
    const roles = [
      { roleDefinitionId: HD_ROLE, GroupId: 'grp-hd', GroupName: 'M365 GDAP Helpdesk', RoleName: 'Helpdesk Administrator' },
      { roleDefinitionId: GA_ROLE, GroupId: 'grp-ga', GroupName: 'M365 GDAP GA', RoleName: 'Global Administrator' },
    ];

    it('enriches roleMappings from ListGDAPRoles, posts Action=Create, returns URLs', async () => {
      const fetchMock = router({
        ListGDAPRoles: () => roles,
        ExecGDAPInvite: () => ({
          Message: 'GDAP relationship invite created.',
          Invite: {
            RowKey: 'rel-123',
            InviteUrl: 'https://admin.microsoft.com/AdminPortal/Home#/partners/invitation/granularAdminRelationships/rel-123',
            OnboardingUrl: 'https://cipp.example/tenant/gdap-management/onboarding/start?id=rel-123',
          },
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const res: GdapInviteResult = await svc.execGDAPInvite([{ roleDefinitionId: HD_ROLE }], 'Ticket 42');

      expect(bodyOf(fetchMock, 'ExecGDAPInvite')).toEqual({
        Action: 'Create',
        roleMappings: [roles[0]],
        Reference: 'Ticket 42',
      });
      expect(res.verified).toBe(true);
      expect(res.relationshipId).toBe('rel-123');
      expect(res.inviteUrl).toMatch(/granularAdminRelationships\/rel-123$/);
      expect(res.onboardingUrl).toMatch(/onboarding\/start\?id=rel-123$/);
    });

    it('does not call ListGDAPRoles when GroupId is supplied', async () => {
      const fetchMock = router({
        ExecGDAPInvite: () => ({ Message: 'ok', Invite: { RowKey: 'r', InviteUrl: 'https://x/r' } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const res = await svc.execGDAPInvite([{ roleDefinitionId: GA_ROLE, GroupId: 'g' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodyOf(fetchMock, 'ExecGDAPInvite').Reference).toBeUndefined();
      expect(res.onboardingUrl).toBeNull();
    });

    it('rejects roles without a configured group mapping before creating anything', async () => {
      const fetchMock = router({ ListGDAPRoles: () => [roles[1]] });
      global.fetch = fetchMock as unknown as typeof fetch;
      await expect(svc.execGDAPInvite([{ roleDefinitionId: HD_ROLE }])).rejects.toThrow(/No CIPP GDAP role mapping/);
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('ExecGDAPInvite'))).toBe(false);
    });

    it('is unverified when CIPP returns 200 without an Invite', async () => {
      global.fetch = router({
        ExecGDAPInvite: () => ({
          Message: 'Error creating GDAP relationship, failed at step: Creating GDAP relationship',
          Invite: null,
        }),
      }) as unknown as typeof fetch;
      const res = await svc.execGDAPInvite([{ roleDefinitionId: GA_ROLE, GroupId: 'g' }]);
      expect(res.verified).toBe(false);
      expect(res.inviteUrl).toBeNull();
      expect(res.message).toMatch(/failed at step/);
      expect(res.message).toMatch(/Do NOT report success/);
    });

    it('rejects an empty roleMappings array', async () => {
      await expect(svc.execGDAPInvite([])).rejects.toThrow(/at least one/);
    });
  });
});
