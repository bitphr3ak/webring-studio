import * as http from 'http';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { WebringMcpServer, JsonRpcRequest } from './mcpServer';

export interface McpHttpServerStatus {
  running: boolean;
  port: number;
  endpointUrl: string;
  sseUrl: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  /** URLs carrying the access token, for MCP clients that send an Origin header (e.g. Electron apps). */
  authorizedEndpointUrl?: string;
  authorizedSseUrl?: string;
}

export interface McpHttpServerOptions {
  /** JSON file that keeps the port and access token stable across restarts. */
  settingsPath?: string;
}

interface StoredHttpSettings {
  port?: number;
  token: string;
}

/**
 * Loopback-only (127.0.0.1) HTTP & SSE MCP Server for Webring Studio.
 * Allows local AI agents and automation tools to connect to the live running
 * Webring Studio instance over Streamable HTTP (`POST /mcp`) or SSE (`GET /mcp/sse`).
 */
export class McpHttpServer {
  private server: http.Server | null = null;
  private port = 0;
  private sseClients = new Set<http.ServerResponse>();
  private settings: StoredHttpSettings;

  constructor(private mcpServer: WebringMcpServer, private options: McpHttpServerOptions = {}) {
    this.settings = this.loadSettings();
  }

  private loadSettings(): StoredHttpSettings {
    const { settingsPath } = this.options;
    if (settingsPath && fs.existsSync(settingsPath)) {
      try {
        const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<StoredHttpSettings>;
        if (typeof stored.token === 'string' && stored.token.length >= 32) {
          return { token: stored.token, port: typeof stored.port === 'number' ? stored.port : undefined };
        }
      } catch {
        // Regenerate below
      }
    }
    return { token: crypto.randomBytes(32).toString('hex') };
  }

  private saveSettings(): void {
    if (!this.options.settingsPath) return;
    fs.writeFileSync(this.options.settingsPath, JSON.stringify(this.settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /**
   * Starts on `preferredPort`, or else the port used last time (so agent configs keep working
   * across restarts), falling back to a random free port if that one is taken.
   */
  public async start(preferredPort = 0): Promise<McpHttpServerStatus> {
    if (this.server && this.port > 0) {
      return this.getStatus();
    }

    const firstChoice = preferredPort || this.settings.port || 0;
    try {
      await this.listen(firstChoice);
    } catch (err) {
      if (firstChoice === 0) throw err;
      await this.listen(0);
    }
    this.settings.port = this.port;
    this.saveSettings();
    return this.getStatus();
  }

  private listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://127.0.0.1:${this.port || 80}`);
        const origin = req.headers.origin;
        const hasToken = this.hasValidToken(req, urlObj);

        // Loopback alone doesn't stop web pages open in the user's browser, so browser-style
        // traffic is refused unless it carries the access token (which pages can't know):
        // no Origin, a loopback Host (blocks DNS rebinding), and JSON-only POSTs (blocks
        // preflight-free "simple" requests).
        const rejection = this.rejectNonAgentRequest(req, hasToken);
        if (rejection) {
          res.writeHead(rejection.status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: rejection.message }));
          return;
        }

        // Token-holding clients that run in a browser context (e.g. Electron renderers) need CORS
        if (hasToken && origin !== undefined) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }
        }

        // 1. Health & Metadata Check
        if (req.method === 'GET' && urlObj.pathname === '/mcp/health') {
          const { authorizedEndpointUrl: _e, authorizedSseUrl: _s, ...publicStatus } = this.getStatus();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(publicStatus, null, 2));
          return;
        }

        // 2. SSE Endpoint (`GET /mcp/sse`)
        if (req.method === 'GET' && urlObj.pathname === '/mcp/sse') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const messageUrl = `http://127.0.0.1:${this.port}/mcp/message${
            hasToken ? `?token=${this.settings.token}` : ''
          }`;
          res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);
          this.sseClients.add(res);
          req.on('close', () => {
            this.sseClients.delete(res);
          });
          return;
        }

        // 3. Streamable HTTP JSON-RPC (`POST /mcp` or `POST /mcp/message`)
        if (
          req.method === 'POST' &&
          (urlObj.pathname === '/mcp' || urlObj.pathname === '/mcp/message')
        ) {
          try {
            const rawBody = await this.readRequestBody(req);
            const parsed = JSON.parse(rawBody);

            if (Array.isArray(parsed)) {
              const responses = [];
              for (const item of parsed) {
                const r = await this.mcpServer.handleJsonRpc(item as JsonRpcRequest);
                if (r) responses.push(r);
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(responses));
              return;
            }

            const rpcResponse = await this.mcpServer.handleJsonRpc(parsed as JsonRpcRequest);

            // Also broadcast over SSE if an SSE client is listening on /mcp/message
            if (urlObj.pathname === '/mcp/message' && rpcResponse) {
              const ssePayload = `event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`;
              for (const client of this.sseClients) {
                client.write(ssePayload);
              }
            }

            if (!rpcResponse) {
              res.writeHead(202);
              res.end();
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(rpcResponse));
            return;
          } catch (err: unknown) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32700,
                  message: err instanceof Error ? err.message : 'Invalid JSON-RPC payload',
                },
              })
            );
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not Found. Use POST /mcp for MCP JSON-RPC 2.0.' }));
      });

      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        this.server = srv;
        resolve();
      });
    });
  }

  /**
   * Accepts the token as `?token=` (works for SSE URLs and CORS preflights) or `Authorization: Bearer`.
   */
  private hasValidToken(req: http.IncomingMessage, urlObj: URL): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    const supplied = urlObj.searchParams.get('token') || bearer || '';
    const expected = Buffer.from(this.settings.token);
    const given = Buffer.from(supplied);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  private rejectNonAgentRequest(
    req: http.IncomingMessage,
    hasToken: boolean
  ): { status: number; message: string } | null {
    if (req.headers.origin !== undefined && !hasToken) {
      return {
        status: 403,
        message: 'Requests with an Origin header need the access token (see the MCP tab in Webring Studio).',
      };
    }
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return { status: 403, message: 'Host must be 127.0.0.1 or localhost.' };
    }
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (req.method === 'POST' && contentType !== 'application/json') {
      return { status: 415, message: 'Content-Type must be application/json.' };
    }
    return null;
  }

  private readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = 5 * 1024 * 1024;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          reject(new Error('Request payload exceeds 5MB limit'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  public getStatus(): McpHttpServerStatus {
    const running = Boolean(this.server && this.port > 0);
    return {
      running,
      port: this.port,
      endpointUrl: running ? `http://127.0.0.1:${this.port}/mcp` : '',
      sseUrl: running ? `http://127.0.0.1:${this.port}/mcp/sse` : '',
      authorizedEndpointUrl: running
        ? `http://127.0.0.1:${this.port}/mcp?token=${this.settings.token}`
        : '',
      authorizedSseUrl: running
        ? `http://127.0.0.1:${this.port}/mcp/sse?token=${this.settings.token}`
        : '',
      toolCount: this.mcpServer.getTools().length,
      resourceCount: this.mcpServer.getResources().length,
      promptCount: this.mcpServer.getPrompts().length,
    };
  }

  public async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      // Don't wait for idle keep-alive sockets to time out
      this.server!.closeAllConnections();
    });
    this.server = null;
    this.port = 0;
  }
}

