/**
 * Adds the owner-only cipp_owner_* tools on top of the standard handler.
 * Kept in its own file so the owner surface is easy to review and remove.
 * Access control lives in mcp-gate: the cipp_owner_* class is granted to no
 * group, so only the Owner sees or calls these tools.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../services/cipp.service.js';
import { Logger } from '../utils/logger.js';
import { CippToolHandler, McpToolResult } from './tool.handler.js';
import { OwnerOps, RequestFn } from '../services/owner-ops.js';
import { OWNER_TOOL_DEFINITIONS } from '../mcp/owner.definitions.js';

/**
 * CippService.request is private in TypeScript only. Reuse it (same base URL,
 * auth and error handling) rather than building a second HTTP client.
 */
export function requestOf(svc: CippService): RequestFn {
  const fn = (svc as unknown as { request: RequestFn }).request;
  if (typeof fn !== 'function') throw new Error('CippService.request is not available.');
  return fn.bind(svc) as RequestFn;
}

export class CippOwnerToolHandler extends CippToolHandler {
  private readonly owner: OwnerOps;
  private readonly ownerLogger: Logger;

  constructor(cippService: CippService, logger: Logger, owner?: OwnerOps) {
    super(cippService, logger);
    this.ownerLogger = logger;
    this.owner = owner ?? new OwnerOps(requestOf(cippService));
  }

  getToolDefinitions() {
    return [...super.getToolDefinitions(), ...OWNER_TOOL_DEFINITIONS] as ReturnType<CippToolHandler['getToolDefinitions']>;
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!name.startsWith('cipp_owner_')) return super.handleToolCall(name, args);
    // OwnerOps validates every field itself.
    const a = (args ?? {}) as any;
    try {
      let result: unknown;
      switch (name) {
        case 'cipp_owner_list_intune_devices':
          result = await this.owner.listIntuneDevices(a.tenantFilter, a.search);
          break;
        case 'cipp_owner_list_intune_policies':
          result = await this.owner.listIntunePolicies(a.tenantFilter);
          break;
        case 'cipp_owner_device_action':
          result = await this.owner.deviceAction(a);
          break;
        case 'cipp_owner_assign':
          result = await this.owner.assign(a);
          break;
        case 'cipp_owner_set_ca_state':
          result = await this.owner.setCaState(a);
          break;
        case 'cipp_owner_create_ca_policy':
          result = await this.owner.createCaPolicy(a);
          break;
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof McpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.ownerLogger.error(`Tool call failed: ${name}`, { error: message });
      throw new McpError(ErrorCode.InternalError, `Tool ${name} failed: ${message}`);
    }
  }
}
