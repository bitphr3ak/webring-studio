#!/usr/bin/env node
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { PersonaManager } from '../services/personaManager';
import { WebringMcpServer, JsonRpcRequest } from './mcpServer';

/**
 * Resolve the default Webring Studio userData directory across Windows, macOS, and Linux,
 * or accept `--data-dir <path>` / `WEBRING_STUDIO_DATA_DIR`.
 */
function resolveDataDir(argv: string[]): string {
  const idx = argv.indexOf('--data-dir');
  if (idx !== -1 && argv[idx + 1]) {
    return path.resolve(argv[idx + 1]);
  }
  if (process.env.WEBRING_STUDIO_DATA_DIR) {
    return path.resolve(process.env.WEBRING_STUDIO_DATA_DIR);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'webring-studio');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'webring-studio');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'webring-studio');
}

async function main() {
  const dataDir = resolveDataDir(process.argv.slice(2));
  const personaManager = new PersonaManager(dataDir);
  const mcpServer = new WebringMcpServer(personaManager, dataDir);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await mcpServer.handleJsonRpc(request);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (err: unknown) {
      const errResp = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: err instanceof Error ? err.message : 'Parse error',
        },
      };
      process.stdout.write(`${JSON.stringify(errResp)}\n`);
    }
  });

  const cleanup = () => {
    personaManager.closeAll();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  process.stderr.write(`Fatal error in webring-studio MCP CLI: ${String(err)}\n`);
  process.exit(1);
});

