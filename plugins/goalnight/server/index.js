#!/usr/bin/env node
/**
 * goalnight MCP server entry.
 *
 * Registers 5 tools that the codex model can call:
 *   - gn_plan_night
 *   - gn_status
 *   - gn_log_finding
 *   - gn_log_decision
 *   - gn_morning_brief
 *
 * Also starts the dashboard HTTP server in the same process (default port 8888).
 *
 * Lifecycle:
 *   codex launches us via .mcp.json with `command: node, args: [server/index.js]`.
 *   We speak JSON-RPC over stdio. The MCP SDK handles framing.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getDb } from './db/client.js';
import { planNight, planNightSchema } from './tools/plan_night.js';
import { status, statusSchema } from './tools/status.js';
import { logFinding, logFindingSchema } from './tools/log_finding.js';
import { logDecision, logDecisionSchema } from './tools/log_decision.js';
import { morningBrief, morningBriefSchema } from './tools/morning_brief.js';
import { startDashboard } from './dashboard/server.js';

// Tool registry — each entry has the JSON schema we expose to the model
// plus the handler function. Schemas live next to the handler files.
const TOOLS = {
  gn_plan_night:    { schema: planNightSchema,    handler: planNight },
  gn_status:        { schema: statusSchema,       handler: status },
  gn_log_finding:   { schema: logFindingSchema,   handler: logFinding },
  gn_log_decision:  { schema: logDecisionSchema,  handler: logDecision },
  gn_morning_brief: { schema: morningBriefSchema, handler: morningBrief },
};

async function main() {
  // Ensure DB exists and schema is applied.
  getDb();

  // Start dashboard server (non-blocking). Failure here should not kill MCP.
  startDashboard().catch(err => {
    // Log to stderr — stdout is reserved for MCP JSON-RPC.
    console.error('[goalnight] dashboard failed to start:', err.message);
  });

  const server = new Server(
    { name: 'goalnight', version: '0.1.0-pre' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, { schema }]) => ({
      name,
      description: schema.description,
      inputSchema: schema.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS[name];
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }
    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server stays alive until stdin closes.
}

main().catch(err => {
  console.error('[goalnight] fatal:', err);
  process.exit(1);
});
