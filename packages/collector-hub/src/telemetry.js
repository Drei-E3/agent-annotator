/**
 * @fileoverview Day-1 Anonymous Telemetry for Universal Agent Annotator (v0.1).
 *
 * Strictly tracks the 6 core lifecycle events:
 *  1. `capture_created`
 *  2. `prompt_copied`
 *  3. `image_copied`
 *  4. `mcp_called`
 *  5. `mcp_config_success`
 *  6. `mcp_config_failed`
 *
 * Privacy guarantee: Never records URLs, DOM text, user comments, or file paths.
 * Tracks the North Star metric: "Weekly annotations successfully consumed by an Agent".
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const TELEMETRY_EVENTS = /** @type {const} */ ([
  'capture_created',
  'prompt_copied',
  'image_copied',
  'mcp_called',
  'mcp_config_success',
  'mcp_config_failed',
]);

const ALLOWED_EVENTS = new Set(TELEMETRY_EVENTS);

/**
 * Resolve the base data directory (`~/.agent-annotator` or `AGENT_ANNOTATOR_HOME`).
 * @returns {string}
 */
export function getDataDir() {
  const dir = process.env.AGENT_ANNOTATOR_HOME || path.join(os.homedir(), '.agent-annotator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get or create a persistent anonymous installation ID.
 * @returns {string}
 */
export function getInstallId() {
  const configPath = path.join(getDataDir(), 'installation.json');
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof parsed.installId === 'string' && parsed.installId.length >= 16) {
        return parsed.installId;
      }
    }
  } catch {
    // Regenerate on corruption
  }
  const installId = `anon_${crypto.randomUUID().replace(/-/g, '')}`;
  fs.writeFileSync(
    configPath,
    JSON.stringify({ installId, createdAt: new Date().toISOString(), version: '0.1.0' }, null, 2),
    'utf8'
  );
  return installId;
}

/**
 * Record one of the 6 core telemetry events locally (and optionally forward to an anonymous endpoint).
 * @param {'capture_created' | 'prompt_copied' | 'image_copied' | 'mcp_called' | 'mcp_config_success' | 'mcp_config_failed'} event
 * @param {Record<string, string | number | boolean | null | undefined>} [props={}]
 */
export function trackEvent(event, props = {}) {
  if (!ALLOWED_EVENTS.has(event)) {
    throw new Error(`Invalid telemetry event "${event}". Allowed: ${TELEMETRY_EVENTS.join(', ')}`);
  }

  // Strip any accidental sensitive keys; keep only safe numeric/categorical counters
  const safeProps = {};
  const allowedPropKeys = new Set([
    'annotation_count',
    'image_count',
    'source',
    'has_component_source',
    'browser_family',
    'formatter',
    'channel',
    'client',
    'tool_name',
    'error_code',
    'batch_id',
  ]);
  for (const [k, v] of Object.entries(props)) {
    if (allowedPropKeys.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      safeProps[k] = v;
    }
  }

  const record = {
    event,
    installId: getInstallId(),
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    platform: process.platform,
    version: '0.1.0',
    props: safeProps,
  };

  const logPath = path.join(getDataDir(), 'telemetry.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');

  // Optional remote anonymous ping if configured via AGENT_ANNOTATOR_TELEMETRY_URL
  const remoteUrl = process.env.AGENT_ANNOTATOR_TELEMETRY_URL;
  if (remoteUrl && typeof fetch === 'function') {
    fetch(remoteUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {});
  }

  return record;
}

/**
 * Read all recorded telemetry events and compute the North Star metric + funnel summary.
 * North Star Metric: Weekly annotations consumed by an Agent (via MCP call or prompt/image copy).
 * @param {{ windowDays?: number }} [options]
 */
export function getTelemetrySummary({ windowDays = 7 } = {}) {
  const logPath = path.join(getDataDir(), 'telemetry.jsonl');
  /** @type {Array<{ event: string, timestamp: string, epochMs: number, props?: Record<string, any> }>} */
  const records = [];
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines
      }
    }
  }

  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const countsAllTime = Object.fromEntries(TELEMETRY_EVENTS.map((e) => [e, 0]));
  const countsWindow = Object.fromEntries(TELEMETRY_EVENTS.map((e) => [e, 0]));

  let weeklyAnnotationsCaptured = 0;
  let weeklyAnnotationsConsumedViaMcp = 0;
  let weeklyAnnotationsConsumedViaClipboard = 0;
  const consumedBatchIds = new Set();
  /** @type {Map<string, number>} */
  const batchAnnotationCounts = new Map();

  for (const r of records) {
    if (r.event in countsAllTime) {
      countsAllTime[r.event] += 1;
    }
    const inWindow = (r.epochMs ?? Date.parse(r.timestamp)) >= cutoffMs;
    if (!inWindow) continue;

    if (r.event in countsWindow) {
      countsWindow[r.event] += 1;
    }
    const annCount = Number(r.props?.annotation_count) || 1;
    const batchId = r.props?.batch_id;

    if (r.event === 'capture_created') {
      weeklyAnnotationsCaptured += annCount;
      if (batchId) batchAnnotationCounts.set(batchId, annCount);
    } else if (r.event === 'mcp_called') {
      weeklyAnnotationsConsumedViaMcp += annCount;
      if (batchId) {
        consumedBatchIds.add(batchId);
        if (!batchAnnotationCounts.has(batchId)) batchAnnotationCounts.set(batchId, annCount);
      }
    } else if (r.event === 'prompt_copied') {
      weeklyAnnotationsConsumedViaClipboard += annCount;
      if (batchId) {
        consumedBatchIds.add(batchId);
        if (!batchAnnotationCounts.has(batchId)) batchAnnotationCounts.set(batchId, annCount);
      }
    }
  }

  let deduplicatedWeeklyConsumedAnnotations = 0;
  if (consumedBatchIds.size > 0) {
    for (const bid of consumedBatchIds) {
      deduplicatedWeeklyConsumedAnnotations += batchAnnotationCounts.get(bid) ?? 1;
    }
  } else {
    deduplicatedWeeklyConsumedAnnotations =
      weeklyAnnotationsConsumedViaMcp + weeklyAnnotationsConsumedViaClipboard;
  }

  return {
    installId: getInstallId(),
    windowDays,
    northStarMetric: {
      name: 'weekly_consumed_annotations',
      value: deduplicatedWeeklyConsumedAnnotations,
      breakdown: {
        captured: weeklyAnnotationsCaptured,
        consumedViaMcp: weeklyAnnotationsConsumedViaMcp,
        consumedViaClipboard: weeklyAnnotationsConsumedViaClipboard,
      },
    },
    countsWindow,
    countsAllTime,
    totalEvents: records.length,
  };
}
