import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AMBRelayClient } from '../relay/client.js';
import { registerSearchTool } from './search.js';
import { registerGetTool } from './get.js';
import {
  registerBrowseSubjectsTool,
  registerBrowseResourceTypesTool,
  registerBrowseEducationalLevelsTool,
} from './browse.js';
import { registerStatsTool } from './stats.js';
import {
  registerListRelaysTool,
  registerAddRelayTool,
  registerRemoveRelayTool,
  registerRelayListGetTool,
} from './relays.js';
import { registerSKOSTools } from './skos.js';
import { registerSKOSBuilderTools } from './skos-builder.js';
import { registerSignerTools } from './signer.js';
import { registerPublishTools } from './publish.js';
import { registerAuthorTools } from './authors.js';
import { registerCalendarTools } from './calendar.js';

/**
 * Register all MCP tools with the server
 */
export function registerTools(
  server: McpServer,
  client: AMBRelayClient,
  calendarClient?: AMBRelayClient
): void {
  // Query tools
  registerSearchTool(server, client);
  registerGetTool(server, client);
  registerBrowseSubjectsTool(server, client);
  registerBrowseResourceTypesTool(server, client);
  registerBrowseEducationalLevelsTool(server, client);
  registerStatsTool(server, client);

  // Relay management tools
  registerListRelaysTool(server, client);
  registerAddRelayTool(server, client);
  registerRemoveRelayTool(server, client);
  registerRelayListGetTool(server, client);

  // SKOS tools
  registerSKOSTools(server);
  registerSKOSBuilderTools(server);

  // Signer and publishing tools
  registerSignerTools(server);
  registerPublishTools(server);

  // Author directory tools
  registerAuthorTools(server);

  // Calendar tools
  if (calendarClient) {
    registerCalendarTools(server, calendarClient);
  }
}
