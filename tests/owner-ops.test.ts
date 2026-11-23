// Tests for the owner-only Intune / Conditional Access tools (OwnerOps).
//
// CIPP contracts (KelvinTegelaar/CIPP-API):
//   ExecDeviceAction  POST { tenantFilter, GUID, Action, keepUserData? }
//   ExecAssignPolicy  POST { tenantFilter, ID, Type, GroupIds, ExcludeGroupIds, assignmentMode, platformType }
//   ExecAssignApp     POST { tenantFilter, ID, Intent, GroupIds, ExcludeGroupIds, assignmentMode }
//   EditCAPolicy      POST { tenantFilter, GUID, State }   -> PATCH state
//   AddCAPolicy       POST { tenantFilter: {value}, RawJSON, NewState, overwrite }
import { OwnerOps } from '../src/services/owner-ops.js';
import { CippService } from '../src/services/cipp.service.js';
import { CippOwnerToolHandler } from '../src/handlers/owner.handler.js';
import { Logger } from '../src/utils/logger.js';

const T = 'contoso.com';
const DEV = '11111111-1111-1111-1111-111111111111';
const GRP = '22222222-2222-2222-2222-222222222222';
const POL = '33333333-3333-3333-3333-333333333333';
const CA = '44444444-4444-4444-4444-444444444444';
const FAST = { timeoutMs: 30, intervalMs: 5 };

type Call = { method: string; path: string; params?: Record<string, unknown>; body?: Record<string, unknown> };

function fake(state: {
  devices?: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  assignments?: Array<Record<string, unknown>>;
  ca?: Array<Record<string, unknown>>;
  applyWrites?: boolean;
}) {
  const s = {
    devices: state.devices ?? [{ id: DEV, deviceName: 'BIS-TECH-99', userPrincipalName: 'a@contoso.com', serialNumber: 'SN1' }],
    groups: state.groups ?? [{ id: GRP, displayName: 'AIT - All Staff' }],
    assignments: state.assignments ?? [],
    ca: state.ca ?? [{ id: CA, displayName: 'AIT - Block personal PCs', state: 'enabledForReportingButNotEnforced' }],
  };
  const apply = state.applyWrites !== false;
  const calls: Call[] = [];
  const req = async <X>(method: string, path: string, params?: Record<string, unknown>, body?: Record<string, unknown>) => {
    calls.push({ method, path, params, body });
    if (method === 'GET' && path === 'ListGraphRequest') {
      const ep = String(params?.Endpoint);
      const f = String(params?.$filter ?? '');
      const idm = /id eq '([^']+)'/.exec(f);
      if (ep === 'deviceManagement/managedDevices')
        return { Results: idm ? s.devices.filter((d) => d.id === idm[1]) : s.devices } as X;
      if (ep === 'groups') return { Results: idm ? s.groups.filter((g) => g.id === idm[1]) : s.groups } as X;
      if (ep.endsWith('/assignments')) return { Results: s.assignments } as X;
      if (ep === 'identity/conditionalAccess/policies') return { Results: s.ca } as X;
      throw new Error(`unexpected endpoint ${ep}`);
    }
    if (method === 'POST' && path === 'ExecDeviceAction') {
      if (apply && body?.Action === 'delete') s.devices = s.devices.filter((d) => d.id !== body.GUID);
      return { Results: 'ok' } as X;
    }
    if (method === 'POST' && (path === 'ExecAssignPolicy' || path === 'ExecAssignApp')) {
      if (apply)
        for (const g of [...((body?.GroupIds as string[]) ?? []), ...((body?.ExcludeGroupIds as string[]) ?? [])])
          s.assignments.push({ target: { groupId: g } });
      return { Results: 'ok' } as X;
    }
    if (method === 'POST' && path === 'EditCAPolicy') {
      if (apply) s.ca = s.ca.map((p) => (p.id === body?.GUID ? { ...p, state: body?.State } : p));
      return { Results: 'ok' } as X;
    }
    if (method === 'POST' && path === 'AddCAPolicy') {
      const j = JSON.parse(String(body?.RawJSON));
      if (apply) s.ca.push({ id: 'new-id', displayName: j.displayName, state: body?.NewState });
      return { Results: ['ok'] } as X;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { ops: new OwnerOps(req as never, FAST), calls, s };
}
const writes = (c: Call[]) => c.filter((x) => x.method === 'POST');

describe('OwnerOps guards', () => {
  it.each([
    ['allTenants'],
    ['AllTenants'],
    [''],
  ])('refuses tenantFilter %p before any call', async (tf) => {
    const { ops, calls } = fake({});
    await expect(ops.deviceAction({ tenantFilter: tf, deviceId: DEV, action: 'sync', confirm: true })).rejects.toThrow(
      /Nothing was sent|single-tenant/
    );
    await expect(ops.setCaState({ tenantFilter: tf, policyId: CA, state: 'disabled', confirm: true })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-GUID deviceId', async () => {
    const { ops, calls } = fake({});
    await expect(ops.deviceAction({ tenantFilter: T, deviceId: 'BIS-TECH-99', action: 'sync' })).rejects.toThrow(/GUID/);
    expect(calls).toHaveLength(0);
  });

  it('handler lists the owner tools and routes them; other tools fall through', async () => {
    const svc = new CippService({ cipp: { baseUrl: 'https://x', apiKey: 'k' } }, new Logger('error'));
    const { ops } = fake({});
    const h = new CippOwnerToolHandler(svc, new Logger('error'), ops);
    const names = h.getToolDefinitions().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['cipp_owner_device_action', 'cipp_owner_create_ca_policy', 'cipp_list_users']));
    const r = await h.handleToolCall('cipp_owner_device_action', { tenantFilter: T, deviceId: DEV, action: 'wipe' });
    expect(JSON.parse(r.content[0].text).status).toBe('preview');
    await expect(h.handleToolCall('cipp_owner_nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('requestOf binds the real CippService request', async () => {
    const svc = new CippService({ cipp: { baseUrl: 'https://x', apiKey: 'k' } }, new Logger('error'));
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"Results":[]}' })) as unknown as typeof fetch;
    const h = new CippOwnerToolHandler(svc, new Logger('error'));
    const r = await h.handleToolCall('cipp_owner_list_intune_devices', { tenantFilter: T });
    expect(JSON.parse(r.content[0].text).count).toBe(0);
  });
});

describe('cipp_owner_device_action', () => {
  it('previews without confirm and sends nothing', async () => {
    const { ops, calls } = fake({});
    const r = await ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'sync' });
    expect(r.status).toBe('preview');
    expect(writes(calls)).toHaveLength(0);
  });

  it.each(['wipe', 'retire', 'delete'] as const)('%s needs the exact device name even with confirm', async (action) => {
    const { ops, calls } = fake({});
    const r = await ops.deviceAction({ tenantFilter: T, deviceId: DEV, action, confirm: true, confirmDeviceName: 'BIS-TECH-98' });
    expect(r.sent).toBe(false);
    expect(r.message).toContain('BIS-TECH-99');
    expect(writes(calls)).toHaveLength(0);
  });

  it('wipe sends ExecDeviceAction with keepUserData false by default and reports queued', async () => {
    const { ops, calls } = fake({});
    const r = await ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'wipe', confirm: true, confirmDeviceName: 'bis-tech-99' });
    expect(r.status).toBe('queued');
    expect(r.verified).toBe(false);
    expect(writes(calls)[0].body).toEqual({ tenantFilter: T, GUID: DEV, Action: 'wipe', keepUserData: false });
  });

  it('sync maps to syncDevice', async () => {
    const { ops, calls } = fake({});
    await ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'sync', confirm: true });
    expect(writes(calls)[0].body?.Action).toBe('syncDevice');
  });

  it('delete is verified only once the record reads back gone', async () => {
    const ok = fake({});
    const r1 = await ok.ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'delete', confirm: true, confirmDeviceName: 'BIS-TECH-99' });
    expect(r1.verified).toBe(true);
    const stuck = fake({ applyWrites: false });
    const r2 = await stuck.ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'delete', confirm: true, confirmDeviceName: 'BIS-TECH-99' });
    expect(r2.status).toBe('unverified');
  });

  it('refuses an unknown device', async () => {
    const { ops, calls } = fake({ devices: [] });
    await expect(ops.deviceAction({ tenantFilter: T, deviceId: DEV, action: 'sync', confirm: true })).rejects.toThrow(/not found/);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('cipp_owner_assign', () => {
  it('previews by default', async () => {
    const { ops, calls } = fake({});
    const r = await ops.assign({ tenantFilter: T, kind: 'policy', policyType: 'configurationPolicies', id: POL, groupIds: [GRP] });
    expect(r.status).toBe('preview');
    expect(r.preview?.include).toEqual(['AIT - All Staff']);
    expect(writes(calls)).toHaveLength(0);
  });

  it('always sends append mode and verifies by readback', async () => {
    const { ops, calls } = fake({});
    const r = await ops.assign({ tenantFilter: T, kind: 'policy', policyType: 'configurationPolicies', id: POL, groupIds: [GRP], confirm: true });
    expect(r.verified).toBe(true);
    const w = writes(calls)[0];
    expect(w.path).toBe('ExecAssignPolicy');
    expect(w.body).toMatchObject({ assignmentMode: 'append', Type: 'configurationPolicies', GroupIds: [GRP] });
  });

  it('routes apps to ExecAssignApp with Required intent by default', async () => {
    const { ops, calls } = fake({});
    await ops.assign({ tenantFilter: T, kind: 'app', id: POL, groupIds: [GRP], confirm: true });
    expect(writes(calls)[0]).toMatchObject({ path: 'ExecAssignApp', body: { Intent: 'Required', assignmentMode: 'append' } });
  });

  it('refuses no groups, unknown groups and a missing policyType', async () => {
    const { ops, calls } = fake({ groups: [] });
    await expect(ops.assign({ tenantFilter: T, kind: 'app', id: POL, confirm: true })).rejects.toThrow(/at least one/);
    await expect(ops.assign({ tenantFilter: T, kind: 'app', id: POL, groupIds: [GRP], confirm: true })).rejects.toThrow(/not found/);
    await expect(ops.assign({ tenantFilter: T, kind: 'policy', id: POL, groupIds: [GRP], confirm: true })).rejects.toThrow(/policyType/);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('cipp_owner_set_ca_state', () => {
  it('enforcing needs the exact policy name', async () => {
    const { ops, calls } = fake({});
    const r = await ops.setCaState({ tenantFilter: T, policyId: CA, state: 'enabled', confirm: true });
    expect(r.status).toBe('preview');
    expect(writes(calls)).toHaveLength(0);
    const r2 = await ops.setCaState({ tenantFilter: T, policyId: CA, state: 'enabled', confirm: true, confirmPolicyName: 'AIT - Block personal PCs' });
    expect(r2.verified).toBe(true);
    expect(writes(calls)[0].body).toEqual({ tenantFilter: T, GUID: CA, State: 'enabled' });
  });

  it('disable needs only confirm', async () => {
    const { ops } = fake({});
    const r = await ops.setCaState({ tenantFilter: T, policyId: CA, state: 'disabled', confirm: true });
    expect(r.verified).toBe(true);
  });

  it('no-op when already in that state', async () => {
    const { ops, calls } = fake({});
    const r = await ops.setCaState({ tenantFilter: T, policyId: CA, state: 'enabledForReportingButNotEnforced', confirm: true });
    expect(r.sent).toBe(false);
    expect(writes(calls)).toHaveLength(0);
  });

  it('unverified when the state does not read back', async () => {
    const { ops } = fake({ applyWrites: false });
    const r = await ops.setCaState({ tenantFilter: T, policyId: CA, state: 'disabled', confirm: true });
    expect(r.status).toBe('unverified');
  });
});

describe('cipp_owner_create_ca_policy', () => {
  const policy = {
    displayName: 'AIT - Require compliant device',
    state: 'enabled',
    conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
    grantControls: { operator: 'OR', builtInControls: ['compliantDevice'] },
  };

  it('forces report-only even when enabled is passed', async () => {
    const { ops, calls } = fake({});
    const r = await ops.createCaPolicy({ tenantFilter: T, policy, confirm: true });
    expect(r.verified).toBe(true);
    const w = writes(calls)[0];
    expect(w.body?.NewState).toBe('enabledForReportingButNotEnforced');
    expect(JSON.parse(String(w.body?.RawJSON)).state).toBe('enabledForReportingButNotEnforced');
    expect(w.body?.overwrite).toBe(false);
    expect(w.body?.tenantFilter).toEqual({ value: T, label: T });
  });

  it('refuses a duplicate name and never overwrites', async () => {
    const { ops, calls } = fake({ ca: [{ id: CA, displayName: 'AIT - Require compliant device', state: 'enabled' }] });
    await expect(ops.createCaPolicy({ tenantFilter: T, policy, confirm: true })).rejects.toThrow(/already exists/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('previews by default', async () => {
    const { ops, calls } = fake({});
    const r = await ops.createCaPolicy({ tenantFilter: T, policy });
    expect(r.status).toBe('preview');
    expect(writes(calls)).toHaveLength(0);
  });
});
