/**
 * Owner-only tool definitions (cipp_owner_*). mcp-gate grants this class to no
 * Entra group, so only the Owner can see or call these. Every write previews
 * first and sends nothing without confirm: true.
 */
import { OWNER_POLICY_TYPES } from '../services/owner-ops.js';

const TENANT = { type: 'string', description: "Tenant domain or ID. Single tenant only; 'allTenants' is refused." };

export const OWNER_TOOL_DEFINITIONS = [
  {
    name: 'cipp_owner_list_intune_devices',
    description:
      'OWNER ONLY. Lists Intune managed devices in one tenant (id, name, primary user, OS, serial, ' +
      'last sync, ownership, compliance). Use it to get the deviceId for cipp_owner_device_action.',
    annotations: { title: 'List Intune devices (owner)', readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT,
        search: { type: 'string', description: 'Optional text to match in device name, user or serial.' },
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_owner_list_intune_policies',
    description:
      'OWNER ONLY. Lists Intune configuration, compliance and settings-catalog policies in one tenant, ' +
      'with ids and types, for cipp_owner_assign.',
    annotations: { title: 'List Intune policies (owner)', readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { tenantFilter: TENANT }, required: ['tenantFilter'] },
  },
  {
    name: 'cipp_owner_device_action',
    description:
      '⚠ OWNER ONLY. Runs an Intune action on ONE device: sync, reboot, defenderScan, defenderUpdate, ' +
      'retire, wipe or delete (record). Without confirm: true it returns a preview only; nothing is sent. ' +
      'retire, wipe and delete also need confirmDeviceName equal to the device name read live from ' +
      'Intune. Wipe is a factory reset and cannot be undone. Queued actions report "queued"; delete is ' +
      'verified by readback.',
    annotations: {
      title: 'Intune device action (owner)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT,
        deviceId: { type: 'string', description: 'Intune managedDevice id (GUID).' },
        action: { type: 'string', enum: ['sync', 'reboot', 'defenderScan', 'defenderUpdate', 'retire', 'wipe', 'delete'] },
        confirm: { type: 'boolean', description: 'Send the action. Default false returns a preview only.', default: false },
        confirmDeviceName: {
          type: 'string',
          description: 'Required for retire, wipe and delete: the exact device name shown in the preview.',
        },
        keepUserData: { type: 'boolean', description: 'Wipe only: keep user data. Default false.', default: false },
      },
      required: ['tenantFilter', 'deviceId', 'action'],
    },
  },
  {
    name: 'cipp_owner_assign',
    description:
      '⚠ OWNER ONLY. Adds include and/or exclude GROUP assignments to one Intune policy or app. ' +
      'Append-only: existing assignments are always kept. No All Users / All Devices targets. ' +
      'Without confirm: true it returns a preview only. Verified when the new groups read back.',
    annotations: {
      title: 'Assign Intune policy or app (owner)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT,
        kind: { type: 'string', enum: ['policy', 'app'] },
        id: { type: 'string', description: 'Policy or app id (GUID).' },
        policyType: {
          type: 'string',
          enum: [...OWNER_POLICY_TYPES],
          description: 'Required when kind is "policy". configurationPolicies = settings catalog.',
        },
        groupIds: { type: 'array', items: { type: 'string' }, description: 'Group ids to include.' },
        excludeGroupIds: { type: 'array', items: { type: 'string' }, description: 'Group ids to exclude.' },
        appIntent: { type: 'string', enum: ['Required', 'Available', 'Uninstall'], description: 'App only. Default Required.' },
        confirm: { type: 'boolean', description: 'Send the assignment. Default false returns a preview only.', default: false },
      },
      required: ['tenantFilter', 'kind', 'id'],
    },
  },
  {
    name: 'cipp_owner_set_ca_state',
    description:
      '⚠ OWNER ONLY. Sets one Conditional Access policy to enabled, disabled or ' +
      'enabledForReportingButNotEnforced (report-only). Without confirm: true it returns a preview only. ' +
      "Enforcing (enabled) also needs confirmPolicyName equal to the policy's display name. Verified " +
      'when the new state reads back.',
    annotations: {
      title: 'Set CA policy state (owner)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT,
        policyId: { type: 'string', description: 'CA policy id (GUID).' },
        state: { type: 'string', enum: ['enabled', 'disabled', 'enabledForReportingButNotEnforced'] },
        confirm: { type: 'boolean', default: false },
        confirmPolicyName: { type: 'string', description: 'Required to enforce: the exact policy display name.' },
      },
      required: ['tenantFilter', 'policyId', 'state'],
    },
  },
  {
    name: 'cipp_owner_create_ca_policy',
    description:
      '⚠ OWNER ONLY. Creates one Conditional Access policy from a Graph conditionalAccessPolicy object, ' +
      'ALWAYS in report-only (any state passed is ignored). Refuses if a policy with the same name ' +
      'exists; never overwrites. Without confirm: true it returns a preview only. Exclude the ' +
      'break-glass account in conditions.users.excludeUsers.',
    annotations: {
      title: 'Create CA policy in report-only (owner)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT,
        policy: {
          type: 'object',
          description: 'Graph conditionalAccessPolicy JSON: displayName, conditions, grantControls/sessionControls.',
        },
        confirm: { type: 'boolean', default: false },
      },
      required: ['tenantFilter', 'policy'],
    },
  },
];

export const OWNER_TOOL_NAMES = OWNER_TOOL_DEFINITIONS.map((t) => t.name);
