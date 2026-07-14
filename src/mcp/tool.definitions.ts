// CIPP MCP Tool Definitions
// Defines every MCP tool the CIPP MCP server exposes, including name,
// description, and JSON Schema for input validation.

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * A single MCP tool definition as required by the MCP protocol.
 */
export interface McpToolDefinition {
  /** Unique, snake_case identifier for the tool. */
  name: string;
  /** Human-readable description surfaced to MCP clients and LLM tool-selectors. */
  description: string;
  /** JSON Schema (object type) describing the tool's accepted input parameters. */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  /** Optional annotations providing hints about the tool's behavior. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Shared property snippets (reused across tools)
// ---------------------------------------------------------------------------

const TENANT_FILTER_PROP = {
  type: 'string',
  description:
    "Tenant domain name or ID to scope the operation. Use 'allTenants' to target every managed tenant.",
};

const USER_ID_PROP = {
  type: 'string',
  description:
    "The target user's Azure AD object ID or User Principal Name (UPN, e.g. alice@contoso.com).",
};

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  // -------------------------------------------------------------------------
  // Tenant tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_tenants',
    description: 'List all tenants managed in CIPP',
    inputSchema: {
      type: 'object',
      properties: {
        allTenants: {
          type: 'boolean',
          description:
            'When true, forces retrieval of every managed tenant regardless of any default filter.',
        },
      },
    },
  },
  {
    name: 'cipp_get_tenant_details',
    description: 'Get detailed information about a specific tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: {
          type: 'string',
          description: "Tenant domain name or ID, use 'allTenants' for all",
        },
      },
      required: ['tenantFilter'],
    },
  },

  // -------------------------------------------------------------------------
  // User tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_users',
    description: 'List users in a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        searchField: {
          type: 'string',
          enum: ['displayName', 'userPrincipalName', 'mail'],
          description:
            'The user attribute to search on. Must be provided together with searchValue.',
        },
        searchValue: {
          type: 'string',
          description:
            'Value to match against the chosen searchField. Supports partial string matching.',
        },
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_create_user',
    description:
      '⚠ HIGH-IMPACT. Creates a new user account in the tenant, which grants ' +
      'directory presence and may include initial credentials and license/role ' +
      'eligibility. Reversible by deleting or disabling the user. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Create user (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        displayName: {
          type: 'string',
          description:
            "The user's full display name as it will appear in the directory (e.g. 'Alice Smith').",
        },
        userPrincipalName: {
          type: 'string',
          description:
            "The user's sign-in address / UPN (e.g. alice@contoso.com). Must be unique within the tenant.",
        },
        password: {
          type: 'string',
          description:
            'Initial password for the account. Should meet the tenant password complexity policy.',
        },
        givenName: {
          type: 'string',
          description: "The user's first (given) name.",
        },
        surname: {
          type: 'string',
          description: "The user's last name (surname).",
        },
        jobTitle: {
          type: 'string',
          description: "The user's job title as it appears in the directory.",
        },
        department: {
          type: 'string',
          description: 'The department the user belongs to.',
        },
        country: {
          type: 'string',
          description:
            "Two-letter ISO 3166-1 alpha-2 country code representing the user's location (e.g. 'US', 'GB').",
        },
      },
      required: ['tenantFilter', 'displayName', 'userPrincipalName', 'password'],
    },
  },
  {
    name: 'cipp_edit_user',
    description:
      "⚠ HIGH-IMPACT. Edits an existing user's properties, which can include " +
      'directory attributes, usage location, and may grant or revoke roles or ' +
      'license eligibility. Reversible by editing again. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Edit user (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: {
          type: 'string',
          description: "The user's Azure AD object ID or UPN to identify the account to modify.",
        },
        displayName: {
          type: 'string',
          description: 'Updated full display name for the user.',
        },
        jobTitle: {
          type: 'string',
          description: 'Updated job title for the user.',
        },
        department: {
          type: 'string',
          description: 'Updated department for the user.',
        },
        usageLocation: {
          type: 'string',
          description:
            "Two-letter ISO 3166-1 alpha-2 country code for license assignment eligibility (e.g. 'US'). Required before assigning most Microsoft 365 licences.",
        },
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_disable_user',
    description:
      '⚠ HIGH-IMPACT. Disables a user account, blocking sign-in. Reversible by ' +
      're-enabling the account. Confirm with the user before invoking.',
    annotations: {
      title: 'Disable user (reversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_reset_password',
    description:
      '⚠ HIGH-IMPACT. Resets a user\'s password, invalidating their current ' +
      'password. Reversible by setting a new password. Confirm with the user before invoking.',
    annotations: {
      title: 'Reset password (reversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
        newPassword: {
          type: 'string',
          description:
            'The replacement password to set. If omitted, a random password is generated and returned in the response.',
        },
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_reset_mfa',
    description:
      '⚠ HIGH-IMPACT. Resets all MFA methods for a user, requiring them to ' +
      're-register their authentication methods. Reversible by re-enabling MFA. Confirm with the user before invoking.',
    annotations: {
      title: 'Reset MFA (reversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_revoke_sessions',
    description:
      '⚠ HIGH-IMPACT. Revokes all active sessions for a user, forcing them to ' +
      're-authenticate. Reversible by the user signing in again. Confirm with the user before invoking.',
    annotations: {
      title: 'Revoke sessions (reversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
        username: {
          type: 'string',
          description:
            "Optional UPN used for CIPP's audit/confirmation string. If omitted, cipp-mcp infers it when userId is already a UPN.",
        },
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_offboard_user',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Completely offboards a user by disabling ' +
      'their account, revoking sessions, removing group memberships, and optionally ' +
      'transferring data. This comprehensive action cannot be easily undone. Confirm with the user before invoking.',
    annotations: {
      title: 'Offboard user (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
        revokePermissions: {
          type: 'boolean',
          description:
            'When true, removes the user from all groups and strips delegated mailbox and SharePoint permissions.',
        },
        disableUser: {
          type: 'boolean',
          description:
            'When true, disables the Azure AD account so the user can no longer sign in.',
        },
        resetPassword: {
          type: 'boolean',
          description:
            'When true, resets the account password as part of the offboarding flow.',
        },
        transferMailbox: {
          type: 'string',
          description:
            'UPN of the recipient who should receive the offboarded mailbox contents via a mailbox export / auto-forward. Omit to skip mailbox transfer.',
        },
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_bec_check',
    description: 'Run a Business Email Compromise check on a user',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_list_mfa_users',
    description: 'List users and their MFA status in a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_user_devices',
    description: 'List devices enrolled by a user',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
      },
      required: ['tenantFilter', 'userId'],
    },
  },
  {
    name: 'cipp_list_user_groups',
    description: 'List groups a user is a member of',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
      },
      required: ['tenantFilter', 'userId'],
    },
  },

  // -------------------------------------------------------------------------
  // Group tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_groups',
    description: 'List groups in a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        search: {
          type: 'string',
          description:
            'Optional text to filter results by group display name. Partial matches are supported.',
        },
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_create_group',
    description:
      '⚠ HIGH-IMPACT. Creates a new group in the tenant, which can be used for ' +
      'security policy assignments (RBAC, Conditional Access) or mail distribution. ' +
      'Reversible by deleting the group. Confirm with the user before invoking.',
    annotations: {
      title: 'Create group (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        displayName: {
          type: 'string',
          description: 'Human-readable name for the new group.',
        },
        groupType: {
          type: 'string',
          enum: ['Generic', 'Security', 'M365', 'Distribution', 'DynamicDistribution', 'AzureRole', 'Dynamic'],
          description:
            'Generic = plain Entra security group. Security = MAIL-ENABLED security group (Exchange). M365 = unified group. Distribution = distribution list. AzureRole = role-assignable. For an ordinary security group use Generic, not Security.',
        },
        username: {
          type: 'string',
          description:
            'Mail alias / local part for group address (e.g. finance-team). Required for M365, Distribution, DynamicDistribution, and Security group types.',
        },
        primDomain: {
          type: 'string',
          description:
            'Optional domain for the group email address. Defaults to the tenant domain when omitted.',
        },
        description: {
          type: 'string',
          description: 'Optional free-text description of the group purpose.',
        },
      },
      required: ['tenantFilter', 'displayName', 'groupType'],
    },
  },

  // -------------------------------------------------------------------------
  // Mailbox tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_mailboxes',
    description: 'List mailboxes in a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        type: {
          type: 'string',
          enum: ['UserMailbox', 'SharedMailbox', 'RoomMailbox', 'EquipmentMailbox'],
          description:
            'Filter mailboxes by recipient type. Omit to return all mailbox types.',
        },
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_mailbox_permissions',
    description: 'List permissions on a specific mailbox',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: {
          type: 'string',
          description: 'User Principal Name of the mailbox whose permissions should be listed.',
        },
      },
      required: ['tenantFilter', 'upn'],
    },
  },
  {
    name: 'cipp_set_out_of_office',
    description:
      '⚠ HIGH-IMPACT. Configures the out-of-office / auto-reply for a mailbox, ' +
      'which causes automated messages to be sent to internal and/or external ' +
      'senders. Reversible by disabling the auto-reply. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Set out-of-office (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: {
          type: 'string',
          description: 'User Principal Name of the mailbox to configure.',
        },
        enabled: {
          type: 'boolean',
          description: 'Set to true to enable the auto-reply, or false to disable it.',
        },
        internalMessage: {
          type: 'string',
          description:
            'HTML or plain-text auto-reply message sent to senders within the same organisation.',
        },
        externalMessage: {
          type: 'string',
          description:
            'HTML or plain-text auto-reply message sent to senders outside the organisation.',
        },
      },
      required: ['tenantFilter', 'upn', 'enabled'],
    },
  },
  {
    name: 'cipp_set_email_forwarding',
    description:
      '⚠ HIGH-IMPACT. Configures email forwarding on a mailbox, silently ' +
      "redirecting the user's incoming mail to another address. This is a common " +
      'data-exfiltration vector. Reversible by removing the forwarding rule. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Set email forwarding (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: {
          type: 'string',
          description: 'User Principal Name of the mailbox to configure forwarding on.',
        },
        forwardTo: {
          type: 'string',
          description:
            'Email address to forward incoming messages to. Omit this parameter to disable forwarding.',
        },
        keepCopy: {
          type: 'boolean',
          description:
            'When true (default), a copy of each forwarded message is retained in the original mailbox.',
          default: true,
        },
      },
      required: ['tenantFilter', 'upn'],
    },
  },

  // -------------------------------------------------------------------------
  // Security tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_conditional_access_policies',
    description: 'List Conditional Access policies for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_named_locations',
    description: 'List named locations (trusted IPs) for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },

  // -------------------------------------------------------------------------
  // Applications tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_enterprise_apps',
    description:
      "List enterprise applications (service principals) in a tenant — including third-party SaaS apps that customers have integrated via OAuth (Slack, Salesforce, Zoom, etc.). Returns appId, displayName, publisher, owner-org, signInAudience, tags, and creation date. Use tenantFilter='allTenants' for cross-tenant fan-out — CIPP handles per-tenant errors inline, so a 403 from one opt-out tenant returns as an error row rather than failing the call. Excludes Microsoft-built-in apps by default (owner org f8cdef31-…); pass includeBuiltIn=true to include them.",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        includeBuiltIn: {
          type: 'boolean',
          description:
            "When true, includes Microsoft-built-in service principals (owner org f8cdef31-a31e-4b4a-93e4-5f571e91255a). Defaults to false (third-party / customer-installed apps only).",
        },
      },
      required: ['tenantFilter'],
    },
  },

  // -------------------------------------------------------------------------
  // Standards tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_standards',
    description: 'List compliance standards configured for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_run_standards_check',
    description: 'Trigger a standards compliance check for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_standard_templates',
    description: 'List the CIPP Standards Templates configured across the partner tenant.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'List standards templates',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_get_tenant_drift',
    description:
      'Report standards drift — settings that deviate from a tenant\'s assigned ' +
      'Standards Template. Omit tenantFilter to report drift across all tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: {
          type: 'string',
          description:
            'Optional tenant domain or ID. Omit to report drift across all managed tenants.',
        },
      },
    },
    annotations: {
      title: 'Get tenant standards drift',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_get_tenant_alignment',
    description:
      "Report each tenant's alignment percentage against its assigned Standards " +
      'Templates — the key signal for deciding which standards are safe to ' +
      'promote to Remediate. Omit tenantFilter to report on all tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: {
          type: 'string',
          description:
            'Optional tenant domain or ID. Omit to report alignment across all managed tenants.',
        },
      },
    },
    annotations: {
      title: 'Get tenant standards alignment',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_create_standard_template',
    description:
      '⚠ HIGH-IMPACT. Creates or updates a CIPP Standards Template (upsert by ' +
      'GUID). A template assigned to tenants with any Remediate-action standard ' +
      'WILL modify those tenants on the next standards run. ' +
      'Confirm with the user before invoking.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description:
            'The full Standards Template JSON object. Must include a "tenantFilter" ' +
            'assigning it to at least one tenant.',
        },
      },
      required: ['template'],
    },
    annotations: {
      title: 'Create/update standards template (high-impact)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'cipp_delete_standard_template',
    description:
      '⚠ HIGH-IMPACT. Permanently deletes a CIPP Standards Template by ID. ' +
      'Tenants assigned to it lose the standards it enforced. ' +
      'Confirm with the user before invoking.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'The GUID of the Standards Template to delete.',
        },
      },
      required: ['templateId'],
    },
    annotations: {
      title: 'Delete standards template (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'cipp_list_bpa',
    description: 'Get Best Practice Analyser results for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_domain_health',
    description: 'Check domain health (DMARC, DKIM, SPF) for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },

  // -------------------------------------------------------------------------
  // License tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_licenses',
    description: 'List license assignments and usage for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_csp_licenses',
    description: 'List all CSP licenses across tenants',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // -------------------------------------------------------------------------
  // Alert tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_audit_logs',
    description: 'List audit log entries for a tenant',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        days: {
          type: 'number',
          description:
            'Number of days to look back when retrieving log entries. Defaults to 7 when omitted.',
        },
        type: {
          type: 'string',
          description:
            'Filter results to a specific log type (e.g. "AzureActiveDirectory", "Exchange", "SharePoint").',
        },
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_list_alert_queue',
    description: 'List queued alerts across all tenants',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // -------------------------------------------------------------------------
  // GDAP tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_gdap_roles',
    description: 'List available GDAP (Granular Delegated Admin Privileges) roles',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cipp_list_gdap_invites',
    description: 'List pending GDAP relationship invites',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // -------------------------------------------------------------------------
  // Scheduler tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_scheduled_items',
    description: 'List scheduled tasks in CIPP',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cipp_add_scheduled_item',
    description: 'Create a new scheduled task',
    inputSchema: {
      type: 'object',
      properties: {
        taskName: {
          type: 'string',
          description: 'Human-readable name to identify this scheduled task in the CIPP UI.',
        },
        command: {
          type: 'string',
          description:
            'The CIPP function or command to execute on the schedule (e.g. "Get-CIPPAlerts").',
        },
        scheduledTime: {
          type: 'string',
          description:
            'ISO 8601 datetime string specifying when the task should first run (e.g. "2024-06-01T09:00:00Z").',
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression or friendly recurrence interval (e.g. "0 9 * * 1" for every Monday at 09:00, or "Daily"). Omit for a one-off task.',
        },
        tenantFilter: {
          type: 'string',
          description:
            "Optional tenant domain name or ID to scope the scheduled task. Use 'allTenants' to run across every managed tenant.",
        },
      },
      required: ['taskName', 'command', 'scheduledTime'],
    },
  },

  // -------------------------------------------------------------------------
  // Core tools
  // -------------------------------------------------------------------------
  {
    name: 'cipp_ping',
    description: 'Check CIPP API connectivity',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cipp_get_version',
    description: 'Get CIPP version information',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cipp_list_logs',
    description: 'List CIPP application logs',
    inputSchema: {
      type: 'object',
      properties: {
        dateFilter: {
          type: 'string',
          description:
            'ISO 8601 date string used to filter log entries to a specific day (e.g. "2024-06-01"). Omit to retrieve recent logs.',
        },
      },
    },
  },
  // -------------------------------------------------------------------------
  // Exchange write depth + BEC containment (CIPP-API 10.6.0)
  // Closes CIPP Daily Ops Manual gaps — pdlaskbis/cyberdrain_cipp issue #1.
  // -------------------------------------------------------------------------
  {
    name: 'cipp_list_mailbox_rules',
    description:
      'Lists the inbox rules configured on mailboxes in a tenant. Read-only. ' +
      'Primary use is spotting malicious rule-based forwarding or message ' +
      'hiding during compromise review (Manual Task 5/6). Note: CIPP builds ' +
      'this data into a per-tenant cache asynchronously — a cold tenant may ' +
      'first return a "still loading, check back in a minute" queue message ' +
      'instead of rows; call again shortly after.',
    annotations: {
      title: 'List mailbox inbox rules',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
      },
      required: ['tenantFilter'],
    },
  },
  {
    name: 'cipp_remove_mailbox_rule',
    description:
      '⚠ HIGH-IMPACT. Permanently removes a single inbox rule from a mailbox. ' +
      'Used to strip attacker-created forwarding/hiding rules during BEC ' +
      'response (Manual Task 5/6). Not reversible — the rule must be recreated ' +
      'by hand if removed in error. Confirm with the user before invoking.',
    annotations: {
      title: 'Remove mailbox inbox rule (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userPrincipalName: {
          type: 'string',
          description: 'UPN of the mailbox the rule belongs to.',
        },
        ruleId: {
          type: 'string',
          description:
            'The mailbox-qualified rule identifier as returned by cipp_list_mailbox_rules. ' +
            'CIPP derives the mailbox object id from this value.',
        },
        ruleName: {
          type: 'string',
          description: 'Optional display name of the rule, used for logging.',
        },
      },
      required: ['tenantFilter', 'userPrincipalName', 'ruleId'],
    },
  },
  {
    name: 'cipp_bec_remediate',
    description:
      '⚠ HIGH-IMPACT. Runs the full bundled Business Email Compromise ' +
      'containment sequence against a suspected-compromised account, in order: ' +
      'reset password, disable account, revoke all sessions, remove MFA ' +
      'methods, disable inbox rules, and disable OneDrive sharing. Returns a ' +
      'per-step result list. This is the one-call containment path for Manual ' +
      'Task 6. Locks the user out immediately. Confirm with the user before ' +
      'invoking, and prefer raising the Autotask Security Incident ticket and ' +
      'preserving evidence first where time allows.',
    annotations: {
      title: 'BEC remediate — full containment (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: {
          type: 'string',
          description: "The compromised user's Azure AD object id.",
        },
        username: {
          type: 'string',
          description: "The compromised user's UPN (e.g. alice@contoso.com).",
        },
      },
      required: ['tenantFilter', 'userId', 'username'],
    },
  },
  {
    name: 'cipp_edit_mailbox_permissions',
    description:
      '⚠ HIGH-IMPACT. Adds or removes mailbox delegation — FullAccess, SendAs, ' +
      'or SendOnBehalf — for one or more delegate users on a target mailbox ' +
      '(Manual Task 9). Granting FullAccess or SendAs exposes another user\u2019s ' +
      'mail, so confirm with the user before invoking. Reversible by applying ' +
      'the opposite operation.',
    annotations: {
      title: 'Edit mailbox permissions (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: {
          type: 'string',
          description: 'UPN of the target mailbox whose permissions are being changed.',
        },
        addFullAccess: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to grant FullAccess (auto-mapping enabled).',
        },
        removeFullAccess: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to remove FullAccess from.',
        },
        addSendAs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to grant SendAs.',
        },
        removeSendAs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to remove SendAs from.',
        },
        addSendOnBehalf: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to grant SendOnBehalf.',
        },
        removeSendOnBehalf: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delegate UPNs to remove SendOnBehalf from.',
        },
      },
      required: ['tenantFilter', 'upn'],
    },
  },
  {
    name: 'cipp_convert_to_shared_mailbox',
    description:
      '⚠ HIGH-IMPACT. Converts a mailbox between Regular, Shared, and Room ' +
      'types (Manual Task 9). Converting a licensed user mailbox to Shared is ' +
      'a common offboarding step so the mailbox can be retained without a ' +
      'license (under 50 GB). Reversible by converting back. Confirm with the ' +
      'user before invoking.',
    annotations: {
      title: 'Convert mailbox type (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        id: {
          type: 'string',
          description: 'UPN or object id of the mailbox to convert.',
        },
        mailboxType: {
          type: 'string',
          enum: ['Regular', 'Shared', 'Room'],
          description: 'Target mailbox type.',
        },
      },
      required: ['tenantFilter', 'id', 'mailboxType'],
    },
  },
  {
    name: 'cipp_edit_group_members',
    description:
      '⚠ HIGH-IMPACT. Adds or removes members of a group (Manual Task 10). ' +
      'Works for Security, Microsoft 365, Distribution, and Mail-Enabled ' +
      'Security groups. Because security-group membership can drive Conditional ' +
      'Access and license assignment, changes here can have broad downstream ' +
      'effect. Reversible by the opposite operation. Confirm before invoking.',
    annotations: {
      title: 'Edit group members (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        groupId: {
          type: 'string',
          description: 'The object id of the group to modify.',
        },
        groupType: {
          type: 'string',
          enum: [
            'Security',
            'Microsoft 365',
            'Distribution List',
            'Mail-Enabled Security',
          ],
          description:
            'The group type. Determines whether membership is changed via Graph ' +
            '(security / M365) or Exchange (distribution / mail-enabled security).',
        },
        addMembers: {
          type: 'array',
          items: { type: 'string' },
          description: 'UPNs of users to add to the group.',
        },
        removeMembers: {
          type: 'array',
          items: { type: 'string' },
          description: 'UPNs of users to remove from the group.',
        },
      },
      required: ['tenantFilter', 'groupId', 'groupType'],
    },
  },
];
// ---------------------------------------------------------------------------
// Tool Categories
// ---------------------------------------------------------------------------

/**
 * Maps a human-readable category label to the names of all tools in that group.
 * Useful for selectively registering or describing subsets of tools.
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  tenants: ['cipp_list_tenants', 'cipp_get_tenant_details'],
  users: [
    'cipp_list_users',
    'cipp_create_user',
    'cipp_edit_user',
    'cipp_disable_user',
    'cipp_reset_password',
    'cipp_reset_mfa',
    'cipp_revoke_sessions',
    'cipp_offboard_user',
    'cipp_bec_check',
    'cipp_bec_remediate',
    'cipp_list_mfa_users',
    'cipp_list_user_devices',
    'cipp_list_user_groups',
  ],
  groups: ['cipp_list_groups', 'cipp_create_group', 'cipp_edit_group_members'],
  mailboxes: [
    'cipp_list_mailboxes',
    'cipp_list_mailbox_permissions',
    'cipp_edit_mailbox_permissions',
    'cipp_convert_to_shared_mailbox',
    'cipp_list_mailbox_rules',
    'cipp_remove_mailbox_rule',
    'cipp_set_out_of_office',
    'cipp_set_email_forwarding',
  ],
  security: ['cipp_list_conditional_access_policies', 'cipp_list_named_locations'],
  applications: ['cipp_list_enterprise_apps'],
  standards: [
    'cipp_list_standards',
    'cipp_run_standards_check',
    'cipp_list_standard_templates',
    'cipp_get_tenant_drift',
    'cipp_get_tenant_alignment',
    'cipp_create_standard_template',
    'cipp_delete_standard_template',
    'cipp_list_bpa',
    'cipp_list_domain_health',
  ],
  licenses: ['cipp_list_licenses', 'cipp_list_csp_licenses'],
  alerts: ['cipp_list_audit_logs', 'cipp_list_alert_queue'],
  gdap: ['cipp_list_gdap_roles', 'cipp_list_gdap_invites'],
  scheduler: ['cipp_list_scheduled_items', 'cipp_add_scheduled_item'],
  core: ['cipp_ping', 'cipp_get_version', 'cipp_list_logs'],
};
