/**
 * Owner-only Intune and Conditional Access operations.
 *
 * Every tool here is named `cipp_owner_*`. mcp-gate grants that class to no
 * Entra group, so only the Owner (see mcp-gate/entra/access.json) can see or
 * call these tools. This file does not enforce identity itself; the gate does.
 *
 * Safety contract shared by every write here:
 *   - Single tenant only: 'allTenants' is refused before any call.
 *   - Preview first: a write is sent only when `confirm` is true AND (for
 *     destructive or enforcing actions) the caller echoes back the exact name
 *     of the thing being changed, read live from the tenant. Without that the
 *     tool returns a preview of what would change and sends nothing.
 *   - Read back after the write, and never report `verified: true` unless the
 *     readback proves the change. Intune device actions are queued by Graph,
 *     so they report `queued`, not verified (delete is the exception: it is
 *     verified once the record reads back as gone).
 *   - Assignments are append-only: these tools never send `replace`, so an
 *     existing assignment can never be wiped by them.
 *   - Conditional Access policies are created in report-only. Turning a policy
 *     to `enabled` (enforced) needs the policy's exact display name echoed back.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export type RequestFn = <T>(
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, unknown>,
  body?: Record<string, unknown>
) => Promise<T>;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OWNER_DEVICE_ACTIONS = {
  sync: 'syncDevice',
  reboot: 'rebootNow',
  defenderScan: 'WindowsDefenderScan',
  defenderUpdate: 'windowsDefenderUpdateSignatures',
  retire: 'retire',
  wipe: 'wipe',
  delete: 'delete',
} as const;
export type OwnerDeviceAction = keyof typeof OWNER_DEVICE_ACTIONS;
const DESTRUCTIVE_ACTIONS: OwnerDeviceAction[] = ['retire', 'wipe', 'delete'];

export const OWNER_POLICY_TYPES = [
  'deviceConfigurations',
  'configurationPolicies',
  'deviceCompliancePolicies',
  'groupPolicyConfigurations',
  'intents',
  'windowsDriverUpdateProfiles',
  'windowsFeatureUpdateProfiles',
  'windowsQualityUpdateProfiles',
] as const;
export type OwnerPolicyType = (typeof OWNER_POLICY_TYPES)[number] | 'mobileApps';

export const CA_STATES = ['enabled', 'disabled', 'enabledForReportingButNotEnforced'] as const;
export type CaState = (typeof CA_STATES)[number];

export interface OwnerResult {
  status: 'preview' | 'queued' | 'verified' | 'unverified';
  verified: boolean;
  sent: boolean;
  tenant: string;
  message: string;
  preview?: Record<string, unknown>;
  submission?: unknown;
  readback?: unknown;
}

interface ManagedDevice {
  id?: string;
  deviceName?: string;
  userPrincipalName?: string;
  operatingSystem?: string;
  osVersion?: string;
  serialNumber?: string;
  lastSyncDateTime?: string;
  managedDeviceOwnerType?: string;
  complianceState?: string;
  azureADDeviceId?: string;
}

interface CaPolicy {
  id?: string;
  displayName?: string;
  state?: string;
}

function eqi(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class OwnerOps {
  constructor(
    private readonly req: RequestFn,
    private readonly poll: { timeoutMs?: number; intervalMs?: number } = {}
  ) {}

  // ---------------------------------------------------------------------------
  // Shared guards and reads
  // ---------------------------------------------------------------------------

  private tenantOf(tool: string, tenantFilter: unknown): string {
    const t = typeof tenantFilter === 'string' ? tenantFilter.trim() : '';
    if (!t) throw new McpError(ErrorCode.InvalidParams, `tenantFilter is required for ${tool}. Nothing was sent.`);
    if (t.toLowerCase() === 'alltenants') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${tool} is single-tenant only; tenantFilter "allTenants" is refused. Nothing was sent.`
      );
    }
    return t;
  }

  private guid(tool: string, field: string, v: unknown): string {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!GUID_RE.test(s)) {
      throw new McpError(ErrorCode.InvalidParams, `${field} must be an object id (GUID) for ${tool}. Nothing was sent.`);
    }
    return s;
  }

  private async graph<T>(tenant: string, endpoint: string, extra: Record<string, unknown> = {}): Promise<T[]> {
    const res = await this.req<{ Results?: unknown } | unknown[]>('GET', 'ListGraphRequest', {
      tenantFilter: tenant,
      Endpoint: endpoint,
      SkipCache: true,
      NoPagination: true,
      ...extra,
    });
    const rows = Array.isArray(res) ? res : (res as { Results?: unknown })?.Results;
    if (!Array.isArray(rows)) {
      throw new McpError(ErrorCode.InternalError, `Unexpected ListGraphRequest response for ${endpoint}.`);
    }
    return rows as T[];
  }

  private async readDevice(tenant: string, deviceId: string): Promise<ManagedDevice | undefined> {
    const rows = await this.graph<ManagedDevice>(tenant, 'deviceManagement/managedDevices', {
      $filter: `id eq '${deviceId}'`,
    });
    return rows.find((r) => eqi(r?.id, deviceId));
  }

  private async sleep(ms: number) {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async pollUntil(check: () => Promise<boolean>): Promise<boolean> {
    const timeoutMs = Math.min(this.poll.timeoutMs ?? 20_000, 20_000);
    const intervalMs = this.poll.intervalMs ?? 4_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ok = false;
      try {
        ok = await check();
      } catch {
        ok = false;
      }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(intervalMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listIntuneDevices(tenantFilter: string, search?: string) {
    const tenant = this.tenantOf('cipp_owner_list_intune_devices', tenantFilter);
    const rows = await this.graph<ManagedDevice>(tenant, 'deviceManagement/managedDevices', {
      $select:
        'id,deviceName,userPrincipalName,operatingSystem,osVersion,serialNumber,lastSyncDateTime,managedDeviceOwnerType,complianceState,azureADDeviceId',
    });
    const q = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const out = rows
      .filter(
        (d) =>
          !q ||
          [d.deviceName, d.userPrincipalName, d.serialNumber].some(
            (v) => typeof v === 'string' && v.toLowerCase().includes(q)
          )
      )
      .map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        user: d.userPrincipalName,
        os: [d.operatingSystem, d.osVersion].filter(Boolean).join(' '),
        serialNumber: d.serialNumber,
        lastSync: d.lastSyncDateTime,
        ownership: d.managedDeviceOwnerType,
        compliance: d.complianceState,
      }));
    return { tenant, count: out.length, devices: out };
  }

  async listIntunePolicies(tenantFilter: string) {
    const tenant = this.tenantOf('cipp_owner_list_intune_policies', tenantFilter);
    const rows = await this.req<unknown>('GET', 'ListIntunePolicy', { TenantFilter: tenant });
    return { tenant, policies: rows };
  }

  // ---------------------------------------------------------------------------
  // Device actions
  // ---------------------------------------------------------------------------

  async deviceAction(args: {
    tenantFilter: string;
    deviceId: string;
    action: OwnerDeviceAction;
    confirm?: boolean;
    confirmDeviceName?: string;
    keepUserData?: boolean;
  }): Promise<OwnerResult> {
    const tool = 'cipp_owner_device_action';
    const tenant = this.tenantOf(tool, args.tenantFilter);
    const deviceId = this.guid(tool, 'deviceId', args.deviceId);
    const action = args.action;
    if (!Object.prototype.hasOwnProperty.call(OWNER_DEVICE_ACTIONS, action)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `action must be one of ${Object.keys(OWNER_DEVICE_ACTIONS).join(', ')}. Nothing was sent.`
      );
    }

    const device = await this.readDevice(tenant, deviceId);
    if (!device?.deviceName) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Intune device ${deviceId} was not found in tenant ${tenant}. Nothing was sent.`
      );
    }
    const destructive = DESTRUCTIVE_ACTIONS.includes(action);
    const who = `${device.deviceName} (${device.userPrincipalName || 'no primary user'}, serial ${device.serialNumber || 'unknown'}, last sync ${device.lastSyncDateTime || 'unknown'})`;
    const preview = {
      action,
      device: who,
      deviceId,
      ownership: device.managedDeviceOwnerType,
      effect:
        action === 'wipe'
          ? `Factory reset${args.keepUserData ? ' keeping user data' : ''}. Cannot be undone.`
          : action === 'retire'
            ? 'Removes company data and management; personal data stays.'
            : action === 'delete'
              ? 'Removes the Intune record only. A device that still checks in will re-enroll.'
              : 'Queues the action on the device at its next check-in.',
    };

    const confirmed =
      args.confirm === true && (!destructive || eqi(args.confirmDeviceName, device.deviceName));
    if (!confirmed) {
      return {
        status: 'preview',
        verified: false,
        sent: false,
        tenant,
        preview,
        message: destructive
          ? `PREVIEW ONLY — nothing sent. To ${action} ${who}, call again with confirm: true and confirmDeviceName: "${device.deviceName}".`
          : `PREVIEW ONLY — nothing sent. Call again with confirm: true to ${action} ${who}.`,
      };
    }

    const body: Record<string, unknown> = {
      tenantFilter: tenant,
      GUID: deviceId,
      Action: OWNER_DEVICE_ACTIONS[action],
    };
    if (action === 'wipe') body.keepUserData = args.keepUserData === true;
    const submission = await this.req<unknown>('POST', 'ExecDeviceAction', undefined, body);

    if (action === 'delete') {
      const gone = await this.pollUntil(async () => !(await this.readDevice(tenant, deviceId)));
      return {
        status: gone ? 'verified' : 'unverified',
        verified: gone,
        sent: true,
        tenant,
        preview,
        submission,
        message: gone
          ? `Deleted the Intune record for ${who} (confirmed not found).`
          : `Delete was sent for ${who}, but the record still reads back. Re-check with cipp_owner_list_intune_devices before reporting success.`,
      };
    }
    return {
      status: 'queued',
      verified: false,
      sent: true,
      tenant,
      preview,
      submission,
      message: `${action} was queued for ${who}. Intune runs it at the device's next check-in; confirm in the Intune device's action status.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Assignments (append-only)
  // ---------------------------------------------------------------------------

  async assign(args: {
    tenantFilter: string;
    kind: 'policy' | 'app';
    id: string;
    policyType?: OwnerPolicyType;
    groupIds?: string[];
    excludeGroupIds?: string[];
    appIntent?: 'Required' | 'Available' | 'Uninstall';
    confirm?: boolean;
  }): Promise<OwnerResult> {
    const tool = 'cipp_owner_assign';
    const tenant = this.tenantOf(tool, args.tenantFilter);
    const id = this.guid(tool, 'id', args.id);
    const include = (args.groupIds ?? []).map((g) => this.guid(tool, 'groupIds[]', g));
    const exclude = (args.excludeGroupIds ?? []).map((g) => this.guid(tool, 'excludeGroupIds[]', g));
    if (include.length === 0 && exclude.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Give at least one groupIds or excludeGroupIds entry. Broad targets (All Users / All Devices) are not offered by this tool. Nothing was sent.'
      );
    }
    let assignmentsEndpoint: string;
    if (args.kind === 'app') {
      assignmentsEndpoint = `deviceAppManagement/mobileApps/${id}/assignments`;
    } else if (args.kind === 'policy') {
      if (!args.policyType || !(OWNER_POLICY_TYPES as readonly string[]).includes(args.policyType)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `policyType must be one of ${OWNER_POLICY_TYPES.join(', ')}. Nothing was sent.`
        );
      }
      assignmentsEndpoint = `deviceManagement/${args.policyType}/${id}/assignments`;
    } else {
      throw new McpError(ErrorCode.InvalidParams, 'kind must be "policy" or "app". Nothing was sent.');
    }

    // Resolve group names so the preview is readable and every id is real.
    const names: Record<string, string> = {};
    for (const g of [...include, ...exclude]) {
      const rows = await this.graph<{ id?: string; displayName?: string }>(tenant, 'groups', {
        $filter: `id eq '${g}'`,
        $select: 'id,displayName',
      });
      const hit = rows.find((r) => eqi(r.id, g));
      if (!hit) {
        throw new McpError(ErrorCode.InvalidParams, `Group ${g} was not found in tenant ${tenant}. Nothing was sent.`);
      }
      names[g] = String(hit.displayName ?? g);
    }
    const before = await this.graph<{ target?: { groupId?: string } }>(tenant, assignmentsEndpoint);
    const preview = {
      kind: args.kind,
      id,
      policyType: args.kind === 'policy' ? args.policyType : 'mobileApps',
      include: include.map((g) => names[g]),
      exclude: exclude.map((g) => names[g]),
      intent: args.kind === 'app' ? (args.appIntent ?? 'Required') : undefined,
      existingAssignments: before.length,
      mode: 'append (existing assignments are kept)',
    };
    if (args.confirm !== true) {
      return {
        status: 'preview',
        verified: false,
        sent: false,
        tenant,
        preview,
        message: 'PREVIEW ONLY — nothing sent. Call again with confirm: true to add these assignments.',
      };
    }

    const body: Record<string, unknown> = {
      tenantFilter: tenant,
      ID: id,
      assignmentMode: 'append',
    };
    if (include.length) body.GroupIds = include;
    if (exclude.length) body.ExcludeGroupIds = exclude;
    let submission: unknown;
    if (args.kind === 'app') {
      body.Intent = args.appIntent ?? 'Required';
      submission = await this.req<unknown>('POST', 'ExecAssignApp', undefined, body);
    } else {
      body.Type = args.policyType;
      body.platformType = 'deviceManagement';
      submission = await this.req<unknown>('POST', 'ExecAssignPolicy', undefined, body);
    }

    let after: Array<{ target?: { groupId?: string } }> = [];
    const ok = await this.pollUntil(async () => {
      after = await this.graph(tenant, assignmentsEndpoint);
      const present = new Set(after.map((a) => String(a?.target?.groupId ?? '').toLowerCase()));
      return [...include, ...exclude].every((g) => present.has(g.toLowerCase()));
    });
    return {
      status: ok ? 'verified' : 'unverified',
      verified: ok,
      sent: true,
      tenant,
      preview,
      submission,
      readback: { assignments: after.length },
      message: ok
        ? `Assignments added and confirmed (${after.length} total on the ${args.kind}).`
        : 'Assignment was sent but the new groups did not read back in time. Re-check before reporting success.',
    };
  }

  // ---------------------------------------------------------------------------
  // Conditional Access
  // ---------------------------------------------------------------------------

  private async readCa(tenant: string): Promise<CaPolicy[]> {
    return this.graph<CaPolicy>(tenant, 'identity/conditionalAccess/policies', {
      $select: 'id,displayName,state',
    });
  }

  async setCaState(args: {
    tenantFilter: string;
    policyId: string;
    state: CaState;
    confirm?: boolean;
    confirmPolicyName?: string;
  }): Promise<OwnerResult> {
    const tool = 'cipp_owner_set_ca_state';
    const tenant = this.tenantOf(tool, args.tenantFilter);
    const policyId = this.guid(tool, 'policyId', args.policyId);
    if (!(CA_STATES as readonly string[]).includes(args.state)) {
      throw new McpError(ErrorCode.InvalidParams, `state must be one of ${CA_STATES.join(', ')}. Nothing was sent.`);
    }
    const policy = (await this.readCa(tenant)).find((p) => eqi(p.id, policyId));
    if (!policy?.displayName) {
      throw new McpError(ErrorCode.InvalidParams, `CA policy ${policyId} was not found in tenant ${tenant}. Nothing was sent.`);
    }
    const preview = { policy: policy.displayName, policyId, from: policy.state, to: args.state };
    if (policy.state === args.state) {
      return {
        status: 'verified',
        verified: true,
        sent: false,
        tenant,
        preview,
        message: `"${policy.displayName}" is already ${args.state}. Nothing was sent.`,
      };
    }
    const enforcing = args.state === 'enabled';
    const confirmed = args.confirm === true && (!enforcing || eqi(args.confirmPolicyName, policy.displayName));
    if (!confirmed) {
      return {
        status: 'preview',
        verified: false,
        sent: false,
        tenant,
        preview,
        message: enforcing
          ? `PREVIEW ONLY — nothing sent. Enforcing a CA policy can lock people out. Check its report-only sign-in results first, then call again with confirm: true and confirmPolicyName: "${policy.displayName}".`
          : `PREVIEW ONLY — nothing sent. Call again with confirm: true to set "${policy.displayName}" to ${args.state}.`,
      };
    }
    const submission = await this.req<unknown>('POST', 'EditCAPolicy', undefined, {
      tenantFilter: tenant,
      GUID: policyId,
      State: args.state,
    });
    let now: CaPolicy | undefined;
    const ok = await this.pollUntil(async () => {
      now = (await this.readCa(tenant)).find((p) => eqi(p.id, policyId));
      return now?.state === args.state;
    });
    return {
      status: ok ? 'verified' : 'unverified',
      verified: ok,
      sent: true,
      tenant,
      preview,
      submission,
      readback: { state: now?.state },
      message: ok
        ? `"${policy.displayName}" is now ${args.state} (confirmed).`
        : `State change was sent but "${policy.displayName}" still reads ${now?.state ?? 'unknown'}. Re-check before reporting success.`,
    };
  }

  async createCaPolicy(args: {
    tenantFilter: string;
    policy: Record<string, unknown>;
    confirm?: boolean;
  }): Promise<OwnerResult> {
    const tool = 'cipp_owner_create_ca_policy';
    const tenant = this.tenantOf(tool, args.tenantFilter);
    const p = args.policy;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new McpError(ErrorCode.InvalidParams, 'policy must be a Graph conditionalAccessPolicy object. Nothing was sent.');
    }
    const name = typeof p.displayName === 'string' ? p.displayName.trim() : '';
    if (!name) throw new McpError(ErrorCode.InvalidParams, 'policy.displayName is required. Nothing was sent.');
    if (!p.conditions || !p.grantControls && !p.sessionControls) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'policy needs conditions and grantControls or sessionControls. Nothing was sent.'
      );
    }
    const existing = await this.readCa(tenant);
    if (existing.some((e) => eqi(e.displayName, name))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `A CA policy named "${name}" already exists in ${tenant}. This tool never overwrites. Nothing was sent.`
      );
    }
    // Report-only, always. The caller's state is ignored on purpose.
    const json = { ...p, state: 'enabledForReportingButNotEnforced' };
    delete (json as Record<string, unknown>).id;
    const preview = { displayName: name, state: 'enabledForReportingButNotEnforced', policy: json };
    if (args.confirm !== true) {
      return {
        status: 'preview',
        verified: false,
        sent: false,
        tenant,
        preview,
        message: `PREVIEW ONLY — nothing sent. Call again with confirm: true to create "${name}" in report-only.`,
      };
    }
    const submission = await this.req<unknown>('POST', 'AddCAPolicy', undefined, {
      tenantFilter: { value: tenant, label: tenant },
      RawJSON: JSON.stringify(json),
      NewState: 'enabledForReportingButNotEnforced',
      overwrite: false,
      DisableSD: false,
      CreateGroups: false,
    });
    let hit: CaPolicy | undefined;
    const ok = await this.pollUntil(async () => {
      hit = (await this.readCa(tenant)).find((e) => eqi(e.displayName, name));
      return hit?.state === 'enabledForReportingButNotEnforced';
    });
    return {
      status: ok ? 'verified' : 'unverified',
      verified: ok,
      sent: true,
      tenant,
      preview: { displayName: name, state: 'enabledForReportingButNotEnforced' },
      submission,
      readback: hit,
      message: ok
        ? `Created "${name}" in report-only (confirmed, id ${hit?.id}). Review its sign-in results before enforcing with cipp_owner_set_ca_state.`
        : `Create was sent but "${name}" did not read back in report-only. Re-check before reporting success.`,
    };
  }
}
