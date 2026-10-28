import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { StaticSiteGenerator } from './siteGenerator';

export interface TestExportPreviewResult {
  success: boolean;
  outputDir: string;
  previewUrl: string;
  port: number;
  filesWritten: Array<{
    relativePath: string;
    sizeBytes: number;
  }>;
  checks: {
    hasIndexHtml: boolean;
    hasNoJekyll: boolean;
    hasDidJson: boolean;
    hasManifestJson: boolean;
    publicFriendsExported: number;
    albumsExported: number;
    itemsExported: number;
  };
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/**
 * Generates a local test export of the active persona's static website and serves it
 * over a loopback-only HTTP server (127.0.0.1) so the user can preview the exact
 * exported files (`index.html`, `/api/*.json`, `/.well-known/did.json`, `/media/*`)
 * in their browser or inside Webring Studio before publishing.
 */
export class LocalPreviewServer {
  private server: http.Server | null = null;
  private currentRootDir: string | null = null;
  private currentPort: number = 0;

  public async runTestExportAndServe(
    siteGenerator: StaticSiteGenerator,
    outputDir: string
  ): Promise<TestExportPreviewResult> {
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const generated = siteGenerator.generateToDirectory(outputDir);
    this.currentRootDir = outputDir;

    await this.ensureServerStarted();

    const filesWritten = generated.filesWritten.map((relPath) => {
      const fullPath = path.join(outputDir, relPath);
      const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      return {
        relativePath: relPath,
        sizeBytes: stat ? stat.size : 0,
      };
    });

    const previewUrl = `http://127.0.0.1:${this.currentPort}/`;

    return {
      success: true,
      outputDir,
      previewUrl,
      port: this.currentPort,
      filesWritten,
      checks: {
        hasIndexHtml: fs.existsSync(path.join(outputDir, 'index.html')),
        hasNoJekyll: fs.existsSync(path.join(outputDir, '.nojekyll')),
        hasDidJson:
          fs.existsSync(path.join(outputDir, '.well-known/did.json')) &&
          fs.existsSync(path.join(outputDir, 'did.json')),
        hasManifestJson: fs.existsSync(path.join(outputDir, 'api/manifest.json')),
        publicFriendsExported: generated.bundle.connections.friends.length,
        albumsExported: generated.bundle.albums.albums.length,
        itemsExported: generated.bundle.items.items.length,
      },
    };
  }

  private async ensureServerStarted(): Promise<void> {
    if (this.server && this.currentPort > 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        if (!this.currentRootDir) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('No active test export directory.');
          return;
        }

        const rawUrl = (req.url || '/').split('?')[0].split('#')[0];
        const decodedPath = decodeURIComponent(rawUrl === '/' ? '/index.html' : rawUrl);
        const safeRelPath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(this.currentRootDir, safeRelPath);

        // Prevent directory traversal outside currentRootDir
        const resolvedRoot = path.resolve(this.currentRootDir);
        const resolvedTarget = path.resolve(fullPath);
        if (!resolvedTarget.startsWith(resolvedRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(resolvedTarget) || fs.statSync(resolvedTarget).isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Not Found: ${decodedPath}`);
          return;
        }

        const ext = path.extname(resolvedTarget).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(resolvedTarget).pipe(res);
      });

      srv.on('error', (err) => {
        reject(err);
      });

      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.currentPort = addr.port;
        }
        this.server = srv;
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.currentPort = 0;
        resolve();
      });
    });
  }
}

