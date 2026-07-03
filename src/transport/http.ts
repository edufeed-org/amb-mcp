/**
 * Streamable HTTP transport for the AMB MCP server.
 *
 * Mounts `@modelcontextprotocol/sdk`'s StreamableHTTPServerTransport behind
 * an Express app at `/mcp` (POST/GET/DELETE) plus a `/healthz` endpoint.
 * Uses stateful sessions so server-push notifications (e.g. progress from
 * the LLM-backed extract_metadata tool) reach the client over SSE.
 *
 * Authentication: read tools are served anonymously (a tokenless /mcp request
 * gets an mcp:read session). A supplied token is fully validated (bad token →
 * 401); a valid token additionally grants its scopes (e.g. mcp:extract). The
 * PRM document is served unauthenticated at
 * /.well-known/oauth-protected-resource (RFC 9728).
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { AuthContext } from './auth.js';
import { AuthError } from './auth.js';
import { buildProtectedResourceMetadata } from './prm.js';

export interface HttpServerOptions {
  port: number;
  host: string;
  /** OAuth resource-server config. When set, every /mcp request needs a valid JWT. */
  auth?: {
    verify: (token: string) => Promise<AuthContext>;
    resourceUrl: string;
    issuer: string;
    scopes: string[];
  };
  /** Host header allow-list for DNS-rebinding protection. */
  allowedHosts?: string[];
  /** Origin allow-list for DNS-rebinding protection. */
  allowedOrigins?: string[];
  /**
   * Factory called once per new MCP session to build a fresh server.
   * Receives the authenticated scopes so the session can be scope-gated.
   * `dispose` (if returned) is invoked when the session closes, so the
   * session's relay connections can be torn down.
   */
  buildMcpServer: (ctx: { scopes: string[] }) => {
    server: McpServer;
    dispose?: () => void | Promise<void>;
  };
  /** Used in /healthz response. */
  serverName?: string;
  serverVersion?: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const {
    port,
    host,
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

  // PRM document served unauthenticated (RFC 9728).
  if (opts.auth) {
    const prm = buildProtectedResourceMetadata({
      resource: opts.auth.resourceUrl,
      issuer: opts.auth.issuer,
      scopes: opts.auth.scopes,
    });
    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(prm));
  }

  // WWW-Authenticate challenge value for 401 responses.
  const challenge = opts.auth
    ? `Bearer resource_metadata="${opts.auth.resourceUrl.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
    : 'Bearer realm="amb-mcp"';

  // JWT middleware applied to /mcp routes.
  const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

    // No credential supplied → anonymous public read.
    if (!token) {
      res.locals.scopes = ['mcp:read'];
      return next();
    }

    // A token was supplied → it must be a valid JWT.
    if (!opts.auth) {
      res.setHeader('WWW-Authenticate', challenge);
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    try {
      const ctx = await opts.auth.verify(token);
      res.locals.scopes = ctx.scopes;
      next();
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      res.setHeader('WWW-Authenticate', challenge);
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', authMiddleware, async (req, res) => {
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
      // Tool profile is fixed at init time from the initializing token's scopes; it is not re-derived per subsequent request on this session.
      const { server: mcp, dispose } = buildMcpServer({ scopes: (res.locals.scopes as string[]) ?? [] });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
        void dispose?.();
      };
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

  app.get('/mcp', authMiddleware, sessionRequestHandler);
  app.delete('/mcp', authMiddleware, sessionRequestHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  const resolvedPort = (server.address() as import('node:net').AddressInfo).port;

  return {
    port: resolvedPort,
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
