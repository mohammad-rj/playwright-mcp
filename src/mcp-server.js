/**
 * MCP server wiring
 *
 * Playwright 1.58's mcpServer.createServer(name, version, backend, runHeartbeat)
 * shipped from a bundled sdk/server.js file that no longer exists in 1.62 - the
 * whole internal folder it lived under is gone, and BrowserBackend has no
 * listTools() any more (tool schemas are the outer server's job now). This
 * module reimplements that same createServer shape directly on top of
 * @modelcontextprotocol/sdk, equivalent to the 1.58 body (createServer /
 * initializeServer / mergeTextParts / addServerListener).
 *
 * Tool schemas come from `backend._tools` (the array BrowserBackend's own
 * constructor stores as `this._tools = tools`), converted to MCP tool
 * descriptors the same way 1.58's sdk/tool.js toMcpTool() did.
 *
 * @module mcp-server
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('./pw');

// Same conversion 1.58's sdk/tool.js toMcpTool() did: readOnly/assertion tools
// get readOnlyHint, everything else is treated as destructive.
function toMcpTool(schema) {
  const readOnly = schema.type === 'readOnly' || schema.type === 'assertion';
  return {
    name: schema.name,
    description: schema.description,
    // zod v4's native converter, matching what playwright 1.62 itself uses.
    // The zodToJsonSchema helper still exported from utilsBundle is the old
    // zod-v3-era library and silently returns a bare {$schema} for a v4
    // schema, which produces tool definitions no MCP client will accept.
    inputSchema: z.toJSONSchema(schema.inputSchema),
    annotations: {
      title: schema.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true,
    },
  };
}

function mergeTextParts(result) {
  const content = [];
  const textParts = [];
  for (const part of result.content) {
    if (part.type === 'text') {
      textParts.push(part.text);
      continue;
    }
    if (textParts.length > 0) {
      content.push({ type: 'text', text: textParts.join('\n') });
      textParts.length = 0;
    }
    content.push(part);
  }
  if (textParts.length > 0)
    content.push({ type: 'text', text: textParts.join('\n') });
  return { ...result, content };
}

function addServerListener(server, event, listener) {
  const oldListener = server[`on${event}`];
  server[`on${event}`] = () => {
    oldListener?.();
    listener();
  };
}

const startHeartbeat = (server) => {
  const beat = () => {
    Promise.race([
      server.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
    ]).then(() => {
      setTimeout(beat, 3000);
    }).catch(() => {
      void server.close();
    });
  };
  beat();
};

const initializeServer = async (server, backend, runHeartbeat) => {
  const capabilities = server.getClientCapabilities();
  let clientRoots = [];
  if (capabilities?.roots) {
    const { roots } = await server.listRoots().catch(() => ({ roots: [] }));
    clientRoots = roots;
  }
  const clientInfo = {
    name: server.getClientVersion()?.name ?? 'unknown',
    version: server.getClientVersion()?.version ?? 'unknown',
    roots: clientRoots,
    // 1.62's BrowserBackend.initialize(clientInfo) reads clientInfo.cwd
    // (used for SessionLog.create and Context's workspace-relative paths).
    cwd: process.cwd(),
    timestamp: Date.now(),
  };
  await backend.initialize?.(clientInfo);
  if (runHeartbeat)
    startHeartbeat(server);
};

function createServer(name, version, backend, runHeartbeat) {
  const server = new Server({ name, version }, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = (backend._tools || []).map((tool) => toMcpTool(tool.schema));
    return { tools };
  });

  let initializePromise;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    let progressCounter = 0;
    const signal = progressToken ? (params) => {
      extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: params.progress ?? ++progressCounter,
          total: params.total,
          message: params.message,
        },
      }).catch(() => {});
    } : () => {};

    try {
      if (!initializePromise)
        initializePromise = initializeServer(server, backend, runHeartbeat);
      await initializePromise;
      const toolResult = await backend.callTool(request.params.name, request.params.arguments || {}, signal);
      return mergeTextParts(toolResult);
    } catch (error) {
      return {
        content: [{ type: 'text', text: '### Result\n' + String(error) }],
        isError: true,
      };
    }
  });

  addServerListener(server, 'close', () => backend.serverClosed?.(server));

  return server;
}

module.exports = { createServer };
