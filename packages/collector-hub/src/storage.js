/**
 * @fileoverview Local disk storage for annotation batches and cropped PNG screenshots.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './telemetry.js';

/**
 * Get the directory where captures are persisted (`~/.agent-annotator/captures`).
 * @returns {string}
 */
export function getCapturesDir() {
  const dir = path.join(getDataDir(), 'captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const BATCH_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

/**
 * Read a non-negative integer from an env var (0 is a valid value), else fall back.
 * @param {string} name
 * @param {number} fallback
 */
function envNonNegInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Atomic write: write to a temp file in the same directory, then rename over the target.
 * @param {string} file
 * @param {string} data
 */
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Read index.json. `ok` is false when the file exists but cannot be parsed.
 * @param {string} indexPath
 * @returns {{ index: any[], ok: boolean }}
 */
function readIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return { index: [], ok: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(parsed) ? { index: parsed, ok: true } : { index: [], ok: false };
  } catch {
    return { index: [], ok: false };
  }
}

export const DEFAULT_MAX_BATCHES = 50;
export const DEFAULT_TTL_DAYS = 7;

/**
 * Garbage-collect old capture directories on disk based on max count and TTL age.
 * Ensures `~/.agent-annotator/captures/` never grows unbounded.
 *
 * @param {{ maxBatches?: number, ttlDays?: number, keepBatchId?: string }} [options]
 * @returns {{ deletedBatchIds: string[], remainingCount: number }}
 */
export function pruneCaptures({
  maxBatches = envNonNegInt('AGENT_ANNOTATOR_MAX_BATCHES', DEFAULT_MAX_BATCHES),
  ttlDays = envNonNegInt('AGENT_ANNOTATOR_TTL_DAYS', DEFAULT_TTL_DAYS),
  keepBatchId,
} = {}) {
  const capturesDir = getCapturesDir();
  const indexPath = path.join(capturesDir, 'index.json');
  const { index, ok: indexReadable } = readIndex(indexPath);
  if (!indexReadable) {
    // Corrupt index: never delete anything based on an unreliable view of history.
    return { deletedBatchIds: [], remainingCount: 0 };
  }

  const cutoffMs = ttlDays > 0 ? Date.now() - ttlDays * 24 * 60 * 60 * 1000 : 0;
  const kept = [];
  const deletedBatchIds = [];

  for (const entry of index) {
    if (!entry || typeof entry.batchId !== 'string' || !BATCH_ID_RE.test(entry.batchId)) continue;
    const createdMs = entry.createdAt ? Date.parse(entry.createdAt) : Date.now();
    const isExpired = cutoffMs > 0 && Number.isFinite(createdMs) && createdMs < cutoffMs;
    const isOverflow = kept.length >= maxBatches;

    if (entry.batchId !== keepBatchId && (isExpired || isOverflow)) {
      const dirToDelete = path.join(capturesDir, path.basename(entry.batchId));
      try {
        fs.rmSync(dirToDelete, { recursive: true, force: true });
      } catch {
        // Ignore deletion errors
      }
      deletedBatchIds.push(entry.batchId);
    } else {
      kept.push(entry);
    }
  }

  // Also sweep any orphan batch_* directories not referenced in kept index
  const keptSet = new Set(kept.map((e) => e.batchId));
  if (keepBatchId) keptSet.add(keepBatchId);
  try {
    for (const dirent of fs.readdirSync(capturesDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && /^batch_/.test(dirent.name) && !keptSet.has(dirent.name)) {
        const orphanPath = path.join(capturesDir, dirent.name);
        try {
          fs.rmSync(orphanPath, { recursive: true, force: true });
          if (!deletedBatchIds.includes(dirent.name)) {
            deletedBatchIds.push(dirent.name);
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore readdir errors
  }

  writeFileAtomic(indexPath, JSON.stringify(kept, null, 2));
  return { deletedBatchIds, remainingCount: kept.length };
}

/**
 * Save a validated AnnotationBatch to disk, writing any base64 PNG screenshots to
 * `~/.agent-annotator/captures/<batchId>/annotation-<index>.png`, populating `localPath`,
 * and running automatic garbage collection on old captures.
 *
 * @param {import('../../shared/src/schema.js').AnnotationBatch} batch
 * @returns {import('../../shared/src/schema.js').AnnotationBatch}
 */
export function saveBatchToDisk(batch) {
  if (!BATCH_ID_RE.test(batch.batchId)) throw new Error('Invalid batchId');
  const batchDir = path.join(getCapturesDir(), batch.batchId);
  fs.mkdirSync(batchDir, { recursive: true });

  const enrichedItems = batch.items.map((item) => {
    if (!item.screenshot?.dataUrl) {
      return item;
    }
    // Only PNG is accepted (the captures route only serves .png).
    const match = /^data:image\/png;base64,(.+)$/.exec(item.screenshot.dataUrl);
    if (!match) {
      const { dataUrl: _drop, ...restShot } = item.screenshot;
      return { ...item, screenshot: restShot };
    }
    const fileName = `annotation-${item.index}.png`;
    const filePath = path.join(batchDir, fileName);
    const buf = Buffer.from(match[1], 'base64');
    fs.writeFileSync(filePath, buf);

    // dataUrl is dropped after writing the PNG: the file on disk is the single copy.
    const { dataUrl: _dataUrl, ...shot } = item.screenshot;
    return {
      ...item,
      screenshot: {
        ...shot,
        localPath: filePath,
      },
    };
  });

  const savedBatch = {
    ...batch,
    items: enrichedItems,
  };

  // Write full batch record to batch.json
  const batchFile = path.join(batchDir, 'batch.json');
  writeFileAtomic(batchFile, JSON.stringify(savedBatch, null, 2));

  // Update index.json (ordered newest-first) and run GC
  const indexPath = path.join(getCapturesDir(), 'index.json');
  let index = readIndex(indexPath).index;
  index = [
    {
      batchId: savedBatch.batchId,
      createdAt: savedBatch.createdAt,
      source: savedBatch.source,
      pageUrl: savedBatch.pageUrl,
      itemCount: savedBatch.items.length,
    },
    ...index.filter((entry) => entry.batchId !== savedBatch.batchId),
  ];

  writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
  pruneCaptures({ keepBatchId: savedBatch.batchId });
  return savedBatch;
}

/**
 * List saved annotation batches (newest first).
 * @param {number} [limit=10]
 */
export function listSavedBatches(limit = 10) {
  const indexPath = path.join(getCapturesDir(), 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(index) ? index.slice(0, limit) : [];
  } catch {
    return [];
  }
}

/**
 * Load a specific AnnotationBatch by batchId, or the latest batch if omitted.
 * @param {string} [batchId]
 * @param {{ withImages?: boolean }} [options] withImages re-hydrates screenshot.dataUrl from the PNG on disk (for MCP image tools only).
 * @returns {import('../../shared/src/schema.js').AnnotationBatch | null}
 */
export function loadSavedBatch(batchId, { withImages = false } = {}) {
  if (batchId !== undefined && batchId !== null && batchId !== '' && !(typeof batchId === 'string' && BATCH_ID_RE.test(batchId))) {
    return null;
  }
  const targetId = batchId || listSavedBatches(1)[0]?.batchId;
  if (!targetId || !BATCH_ID_RE.test(targetId)) return null;
  const batchFile = path.join(getCapturesDir(), targetId, 'batch.json');
  if (!fs.existsSync(batchFile)) return null;
  try {
    const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    if (withImages) {
      const batchDir = path.join(getCapturesDir(), targetId);
      for (const item of batch.items || []) {
        const lp = item.screenshot?.localPath;
        // Only read files that live inside this batch's own directory.
        if (lp && !item.screenshot.dataUrl && path.dirname(path.resolve(lp)) === batchDir && lp.endsWith('.png') && fs.existsSync(lp)) {
          item.screenshot.dataUrl = `data:image/png;base64,${fs.readFileSync(lp).toString('base64')}`;
        }
      }
    }
    return batch;
  } catch {
    return null;
  }
}
