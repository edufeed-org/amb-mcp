/**
 * Streamable HTTP transport for the AMB MCP server.
 *
 * Mounts `@modelcontextprotocol/sdk`'s StreamableHTTPServerTransport behind
 * an Express app at `/mcp` (POST/GET/DELETE) plus a `/healthz` endpoint.
 * Uses stateful sessions so server-push notifications (e.g. progress from
 * the LLM-backed extract_metadata tool) reach the client over SSE.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpServerOptions {
  port: number;
  host: string;
  /** If set, every /mcp request must carry `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Host header allow-list for DNS-rebinding protection. */
  allowedHosts?: string[];
  /** Origin allow-list for DNS-rebinding protection. */
  allowedOrigins?: string[];
  /** Factory called once per new MCP session to build a fresh server. */
  buildMcpServer: () => McpServer;
  /** Used in /healthz response. */
  serverName?: string;
  serverVersion?: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const {
    port,
    host,
    bearerToken,
    allowedHosts,
    allowedOrigins,
    buildMcpServer,
    serverName = 'amb-mcp',
    serverVersion = '0.0.0',
  } = opts;

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(
    cors({
      origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : '*',
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version', 'WWW-Authenticate'],
      allowedHeaders: ['Content-Type', 'Mcp-Session-Id', 'Authorization', 'Mcp-Protocol-Version'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );

  // /healthz stays unauthenticated and outside the session map.
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: serverName,
      version: serverVersion,
      sessions: transports.size,
    });
  });

  // Bearer-token middleware applied only to /mcp.
  const bearerAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!bearerToken) return next();
    const header = req.headers.authorization;
    const got = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    if (got !== bearerToken) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="amb-mcp"');
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    next();
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', bearerAuth, async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : undefined;

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) transports.set(id, transport);
        },
        enableDnsRebindingProtection: Boolean(
          (allowedHosts && allowedHosts.length > 0) ||
            (allowedOrigins && allowedOrigins.length > 0),
        ),
        allowedHosts,
        allowedOrigins,
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = buildMcpServer();
      await mcp.connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session: send an initialize request first' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequestHandler = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or missing session' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', bearerAuth, sessionRequestHandler);
  app.delete('/mcp', bearerAuth, sessionRequestHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });

  return {
    async close() {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          // ignore individual transport close failures
        }
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
