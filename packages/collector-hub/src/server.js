/**
 * @fileoverview Local Collector Hub HTTP Server (default: http://127.0.0.1:17380).
 * Accepts annotation batches from the browser extension (or future desktop collector),
 * persists cropped PNG screenshots, formats prompt text via pluggable FormatterStrategy,
 * writes to system clipboard, and records Day-1 anonymous telemetry.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { validateAnnotationBatch } from '../../shared/src/schema.js';
import { getFormatter } from '../../shared/src/formatter.js';
import { saveBatchToDisk, listSavedBatches, loadSavedBatch, getCapturesDir } from './storage.js';
import { copyTextToClipboard, copyPngFileToClipboard } from './clipboard.js';
import { trackEvent, getTelemetrySummary, TELEMETRY_EVENTS } from './telemetry.js';
import { renderPlaygroundHtml } from './playground.js';

export const DEFAULT_HUB_PORT = 17380;
export const DEFAULT_HUB_HOST = '127.0.0.1';

/**
 * Create and start the Local Collector Hub HTTP server.
 * @param {{ port?: number, host?: string, autoClipboard?: boolean, formatterName?: string }} [options]
 * @returns {Promise<{ server: http.Server, port: number, host: string, close: () => Promise<void> }>}
 */
export function startCollectorServer({
  port = Number(process.env.AGENT_ANNOTATOR_PORT) || DEFAULT_HUB_PORT,
  host = DEFAULT_HUB_HOST,
  autoClipboard = true,
  formatterName = 'canonical',
} = {}) {
  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: only accept our own loopback Host values.
    const actualPort = server.address() && typeof server.address() === 'object' ? server.address().port : port;
    const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      sendJson(res, 403, { ok: false, error: 'Forbidden host' });
      return;
    }

    // CORS: only browser extensions and the Hub's own origin (no wildcard). Requests without an
    // Origin header (CLI / MCP / same-origin GET) are not browser cross-origin requests.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const originOk =
        /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin) ||
        origin === `http://127.0.0.1:${actualPort}` ||
        origin === `http://localhost:${actualPort}`;
      if (!originOk) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Simple cross-site POSTs (text/plain etc.) must not be accepted as JSON.
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${host}:${port}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/playground')) {
        const html = renderPlaygroundHtml({ port });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/captures/')) {
        const parts = url.pathname.slice('/api/captures/'.length).split('/');
        if (parts.length === 2) {
          const safeBatch = path.basename(decodeURIComponent(parts[0]));
          const safeFile = path.basename(decodeURIComponent(parts[1]));
          const imgPath = path.join(getCapturesDir(), safeBatch, safeFile);
          if (fs.existsSync(imgPath) && safeFile.endsWith('.png')) {
            const buf = fs.readFileSync(imgPath);
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': buf.length,
              'Cache-Control': 'no-cache',
            });
            res.end(buf);
            return;
          }
        }
        sendJson(res, 404, { ok: false, error: 'Capture image not found' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'agent-annotator-hub',
          version: '0.1.0',
          formatter: formatterName,
          playgroundUrl: `http://${host}:${port}/playground`,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/batches') {
        const limit = Number(url.searchParams.get('limit')) || 10;
        sendJson(res, 200, { ok: true, batches: listSavedBatches(limit) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/batches/latest') {
        const batch = loadSavedBatch();
        if (!batch) {
          sendJson(res, 404, { ok: false, error: 'No annotation batches found' });
          return;
        }
        const formatter = getFormatter(url.searchParams.get('formatter') || formatterName);
        const formatted = formatter.serialize(batch);
        sendJson(res, 200, { ok: true, batch, formatted });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/batches') {
        const rawBody = await readJsonBody(req);
        const validation = validateAnnotationBatch(rawBody);
        if (!validation.ok) {
          sendJson(res, 400, { ok: false, error: validation.error });
          return;
        }

        // 1. Save batch and cropped PNG screenshots to ~/.agent-annotator/captures/<batchId>/
        const savedBatch = saveBatchToDisk(validation.data);
        const imageCount = savedBatch.items.filter((i) => Boolean(i.screenshot?.localPath)).length;
        const hasComponentSource = savedBatch.items.some(
          (i) => Boolean(i.browserContext?.componentContext?.filePath || i.browserContext?.componentContext?.componentName)
        );

        // 2. Track capture_created telemetry
        trackEvent('capture_created', {
          batch_id: savedBatch.batchId,
          annotation_count: savedBatch.items.length,
          image_count: imageCount,
          source: savedBatch.source,
          has_component_source: hasComponentSource,
          browser_family: savedBatch.browserFamily || 'unknown',
        });

        // 3. Serialize via active FormatterStrategy
        const formatter = getFormatter(rawBody.formatter || formatterName);
        const formatted = formatter.serialize(savedBatch);

        // 4. Dual-channel clipboard support (default: copy prompt text containing local image paths; optional: copy PNG bitmap)
        const clipboardMode = rawBody.clipboardMode || 'prompt'; // 'prompt' | 'image' | 'none'
        const clipboardResult = { promptCopied: false, imageCopied: false };

        if (autoClipboard && clipboardMode !== 'none') {
          if (clipboardMode === 'image') {
            const firstPng = savedBatch.items.find((i) => i.screenshot?.localPath)?.screenshot?.localPath;
            if (firstPng) {
              const imgRes = copyPngFileToClipboard(firstPng);
              clipboardResult.imageCopied = imgRes.ok;
              if (imgRes.ok) {
                trackEvent('image_copied', {
                  batch_id: savedBatch.batchId,
                  annotation_count: savedBatch.items.length,
                  image_count: 1,
                  channel: 'hub_osascript',
                });
              }
            }
          } else {
            const txtRes = copyTextToClipboard(formatted.text);
            clipboardResult.promptCopied = txtRes.ok;
            if (txtRes.ok) {
              trackEvent('prompt_copied', {
                batch_id: savedBatch.batchId,
                annotation_count: savedBatch.items.length,
                formatter: formatter.name,
                channel: 'hub_pbcopy',
              });
            }
            if (imageCount > 0) {
              // Local PNG paths are embedded in the prompt and saved on disk ready for Agent consumption
              trackEvent('image_copied', {
                batch_id: savedBatch.batchId,
                annotation_count: savedBatch.items.length,
                image_count: imageCount,
                channel: 'local_file_path',
              });
              clipboardResult.imageCopied = true;
            }
          }
        }

        sendJson(res, 200, {
          ok: true,
          batchId: savedBatch.batchId,
          itemCount: savedBatch.items.length,
          imagePaths: savedBatch.items.map((i) => i.screenshot?.localPath).filter(Boolean),
          formatted: {
            strategy: formatted.strategy,
            text: formatted.text,
          },
          clipboard: clipboardResult,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/telemetry') {
        const body = await readJsonBody(req);
        if (!body || !TELEMETRY_EVENTS.includes(body.event)) {
          sendJson(res, 400, { ok: false, error: 'Invalid telemetry event' });
          return;
        }
        const rec = trackEvent(body.event, body.props || {});
        sendJson(res, 200, { ok: true, event: rec.event });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        sendJson(res, 200, { ok: true, stats: getTelemetrySummary() });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        host,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 35 * 1024 * 1024; // 35 MB ceiling for batch with cropped PNGs
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error('Payload exceeds 35MB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
