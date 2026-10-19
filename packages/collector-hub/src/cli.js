#!/usr/bin/env node
/**
 * @fileoverview CLI entry point for Universal Agent Annotator (v0.1).
 *
 * Commands:
 *  - `annotator serve`       : Start Local Collector Hub on http://127.0.0.1:17380
 *  - `annotator mcp`         : Start stdio MCP Server for AI coding agents
 *  - `annotator install-mcp` : One-click MCP setup for Claude Code, Cursor, Codex, Antigravity
 *  - `annotator doctor`      : Verify Hub, clipboard, storage, extension, and MCP setup
 *  - `annotator stats`       : Show North Star metric & 6 core anonymous telemetry events
 *  - `annotator benchmark`   : Evaluate the 20-case UI bug benchmark gate
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCollectorServer, DEFAULT_HUB_PORT, DEFAULT_HUB_HOST } from './server.js';
import { startMcpStdioServer } from './mcp.js';
import { getDataDir, getTelemetrySummary, trackEvent } from './telemetry.js';
import { copyTextToClipboard } from './clipboard.js';
import { evaluateBenchmark } from '../../../benchmarks/evaluate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? Number(args[portIdx + 1]) : undefined;
      const hub = await startCollectorServer({ port });
      console.log(`⚡ Agent Annotator Hub listening on http://${hub.host}:${hub.port}`);
      console.log(`🧪 W1 Verification Playground : http://${hub.host}:${hub.port}/playground`);
      console.log(`📁 Captures directory         : ${path.join(getDataDir(), 'captures')}`);
      console.log(`🧩 Unpacked Extension path    : ${path.join(REPO_ROOT, 'packages/browser-extension')}`);
      console.log(`Press Ctrl+C to stop.`);
      break;
    }

    case 'mcp': {
      startMcpStdioServer();
      break;
    }

    case 'install-mcp': {
      const dryRun = args.includes('--dry-run');
      const clientIdx = args.indexOf('--client');
      const targetClient = clientIdx !== -1 ? args[clientIdx + 1] : 'all';
      runInstallMcp({ dryRun, targetClient });
      break;
    }

    case 'install-service': {
      runInstallLaunchAgent();
      break;
    }

    case 'pack': {
      runPackExtensionRelease();
      break;
    }

    case 'doctor': {
      await runDoctor();
      break;
    }

    case 'stats': {
      runStats();
      break;
    }

    case 'benchmark': {
      const fileIdx = args.indexOf('--file');
      const benchFile =
        fileIdx !== -1 ? path.resolve(args[fileIdx + 1]) : path.join(REPO_ROOT, 'benchmarks/cases.json');
      evaluateBenchmark(benchFile);
      break;
    }

    default: {
      printHelp();
      break;
    }
  }
}

/**
 * One-click MCP configuration installer for popular AI coding agents.
 * Records `mcp_config_success` or `mcp_config_failed` telemetry.
 * @param {{ dryRun?: boolean, targetClient?: string }} options
 */
export function runInstallMcp({ dryRun = false, targetClient = 'all' } = {}) {
  const cliPath = path.resolve(__dirname, 'cli.js');
  const nodeBin = process.execPath;

  const clientTargets = [
    {
      id: 'antigravity',
      name: 'Antigravity',
      configPath: path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
      format: 'json-mcpServers',
    },
    {
      id: 'claude_code',
      name: 'Claude Code',
      configPath: path.join(os.homedir(), '.claude.json'),
      format: 'json-mcpServers',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
      format: 'json-mcpServers',
    },
    {
      id: 'codex',
      name: 'Codex',
      configPath: path.join(os.homedir(), '.codex', 'config.toml'),
      format: 'toml-codex',
    },
  ];

  const selected =
    targetClient === 'all' ? clientTargets : clientTargets.filter((c) => c.id === targetClient);

  if (selected.length === 0) {
    trackEvent('mcp_config_failed', {
      client: targetClient,
      error_code: 'unknown_client',
    });
    console.error(
      `Unknown client "${targetClient}". Supported: antigravity, claude_code, cursor, codex, all`
    );
    process.exitCode = 1;
    return;
  }

  for (const target of selected) {
    try {
      const parentDir = path.dirname(target.configPath);
      const exists = fs.existsSync(target.configPath);

      if (target.format === 'toml-codex') {
        const sectionHeader = '[mcp_servers.agent-annotator]';
        const tomlBlock = `${sectionHeader}\ncommand = ${JSON.stringify(nodeBin)}\nargs = [${JSON.stringify(cliPath)}, "mcp"]\n`;
        const currentToml = exists ? fs.readFileSync(target.configPath, 'utf8') : '';

        if (dryRun) {
          console.log(`[dry-run] Would update ${target.name} (${target.configPath}):\n${tomlBlock}`);
          continue;
        }

        fs.mkdirSync(parentDir, { recursive: true });

        // Re-read right before writing to keep the race window with other writers minimal.
        const latestToml = exists ? fs.readFileSync(target.configPath, 'utf8') : currentToml;
        let updatedToml;
        if (/^\[mcp_servers\.agent-annotator\]\s*$/m.test(latestToml)) {
          // Replace only the main table body (up to the next header); sub-tables such as
          // [mcp_servers.agent-annotator.env] are separate headers and are preserved.
          updatedToml = latestToml.replace(
            /^\[mcp_servers\.agent-annotator\][^\n]*\n[\s\S]*?(?=^\[|(?![\s\S]))/m,
            tomlBlock + (/^\[/m.test(latestToml.split(sectionHeader)[1] || '') ? '\n' : '')
          );
        } else {
          updatedToml = `${latestToml.trimEnd()}\n\n${tomlBlock}`;
        }

        if (updatedToml === latestToml) {
          console.log(`✅ ${target.name} MCP already configured (${target.configPath})`);
          continue;
        }
        if (exists) backupConfig(target.configPath);
        writeFileAtomic(target.configPath, updatedToml);
        trackEvent('mcp_config_success', { client: target.id });
        console.log(`✅ Configured ${target.name} MCP at ${target.configPath}`);
        continue;
      }

      const entry = { command: nodeBin, args: [cliPath, 'mcp'] };
      const loadConfig = () => {
        if (!fs.existsSync(target.configPath)) return {};
        const raw = fs.readFileSync(target.configPath, 'utf8').trim();
        return raw ? JSON.parse(raw) : {}; // throws on invalid JSON -> we abort without writing
      };
      let configObj = loadConfig();
      configObj.mcpServers = configObj.mcpServers || {};
      configObj.mcpServers['agent-annotator'] = entry;

      if (dryRun) {
        console.log(`[dry-run] Would update ${target.name} (${target.configPath}):`);
        console.log(JSON.stringify(configObj.mcpServers['agent-annotator'], null, 2));
      } else {
        fs.mkdirSync(parentDir, { recursive: true });
        // Re-read immediately before writing (other tools, e.g. Claude Code, also write this file)
        // and only touch our own entry so concurrent changes to other keys are preserved.
        const before = fs.existsSync(target.configPath) ? fs.readFileSync(target.configPath, 'utf8') : '';
        configObj = loadConfig();
        configObj.mcpServers = configObj.mcpServers || {};
        const prev = JSON.stringify(configObj.mcpServers['agent-annotator']);
        if (prev === JSON.stringify(entry)) {
          console.log(`✅ ${target.name} MCP already configured (${target.configPath})`);
          continue;
        }
        configObj.mcpServers['agent-annotator'] = entry;
        if (exists && before) backupConfig(target.configPath);
        writeFileAtomic(target.configPath, JSON.stringify(configObj, null, 2) + '\n');
        trackEvent('mcp_config_success', { client: target.id });
        console.log(`✅ Configured ${target.name} MCP at ${target.configPath}`);
      }
    } catch (err) {
      trackEvent('mcp_config_failed', {
        client: target.id,
        error_code: 'write_or_parse_error',
      });
      console.error(
        `❌ Failed to configure ${target.name} (${target.configPath}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/**
 * Write a file atomically (temp file in same directory + rename), preserving the original mode.
 * @param {string} file
 * @param {string} data
 */
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
}

/**
 * Timestamped backup (`<file>.bak-<ts>`), keeping only the 3 most recent so earlier
 * originals are not silently overwritten on every run.
 * @param {string} file
 */
function backupConfig(file) {
  fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
  for (const old of baks.slice(0, Math.max(0, baks.length - 3))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      // ignore
    }
  }
}

/**
 * Run comprehensive health diagnostics (`annotator doctor`).
 */
export async function runDoctor() {
  console.log('🩺 Running Agent Annotator v0.1 Doctor...\n');
  const checks = [];

  // 1. Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js Runtime (>=20)',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node} (${process.execPath})`,
  });

  // 2. Data & Captures directory writable
  try {
    const dataDir = getDataDir();
    const probe = path.join(dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    checks.push({ name: 'Local Storage (~/.agent-annotator)', ok: true, detail: dataDir });
  } catch (err) {
    checks.push({
      name: 'Local Storage (~/.agent-annotator)',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Unpacked Browser Extension files
  const extDir = path.join(REPO_ROOT, 'packages/browser-extension');
  const manifestPath = path.join(extDir, 'manifest.json');
  let extOk = false;
  let extDetail = extDir;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const perms = manifest.permissions || [];
    const hasActiveTab = perms.includes('activeTab');
    const hasAllUrls =
      perms.includes('<all_urls>') || (manifest.host_permissions || []).includes('<all_urls>');
    extOk = hasActiveTab && !hasAllUrls && !manifest.content_scripts;
    extDetail = `permissions=[${perms.join(', ')}], on-demand injection=${!manifest.content_scripts}`;
  } else {
    extDetail = 'manifest.json missing';
  }
  checks.push({ name: 'Browser Extension (MV3 activeTab)', ok: extOk, detail: extDetail });

  // 4. Local Hub HTTP Reachability & W1 Playground
  let hubOnline = false;
  try {
    const res = await fetch(`http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    hubOnline = res.ok;
  } catch {
    hubOnline = false;
  }
  checks.push({
    name: `Local Collector Hub (${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT})`,
    ok: hubOnline,
    detail: hubOnline
      ? `Running (W1 Playground: http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}/playground)`
      : 'Not running (start with `npm start` or `annotator serve`; extension offline clipboard fallback still works)',
  });

  // 5. MCP Client Registration Check
  const jsonMcpConfigs = [
    { label: 'Antigravity', path: path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json') },
    { label: 'Claude Code', path: path.join(os.homedir(), '.claude.json') },
    { label: 'Cursor', path: path.join(os.homedir(), '.cursor', 'mcp.json') },
  ];
  const registeredIn = [];
  for (const cfg of jsonMcpConfigs) {
    if (fs.existsSync(cfg.path)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfg.path, 'utf8'));
        if (parsed?.mcpServers?.['agent-annotator']) {
          registeredIn.push(cfg.label);
        }
      } catch {
        // Ignore
      }
    }
  }
  const codexToml = path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(codexToml)) {
    try {
      if (fs.readFileSync(codexToml, 'utf8').includes('[mcp_servers.agent-annotator]')) {
        registeredIn.push('Codex');
      }
    } catch {
      // Ignore
    }
  }

  checks.push({
    name: 'MCP Client Registration',
    ok: registeredIn.length > 0,
    detail:
      registeredIn.length > 0
        ? `Registered in: ${registeredIn.join(', ')}`
        : 'Not registered yet (run `npm run install-mcp`)',
  });

  // Print table
  for (const c of checks) {
    console.log(`${c.ok ? '✅' : '⚠️ '} ${c.name.padEnd(38)} ${c.detail}`);
  }
}

/**
 * Print North Star metric and 6 core telemetry event counts (`annotator stats`).
 */
export function runStats() {
  const summary = getTelemetrySummary({ windowDays: 7 });
  console.log('📊 Agent Annotator Telemetry & North Star Metric (Local-First)\n');
  console.log(`Anonymous Install ID : ${summary.installId}`);
  console.log(
    `🌟 North Star Metric  : ${summary.northStarMetric.value} annotations consumed by Agents (last 7 days)`
  );
  console.log(
    `   ├─ Captured       : ${summary.northStarMetric.breakdown.captured}`
  );
  console.log(
    `   ├─ Via MCP        : ${summary.northStarMetric.breakdown.consumedViaMcp}`
  );
  console.log(
    `   └─ Via Clipboard  : ${summary.northStarMetric.breakdown.consumedViaClipboard}\n`
  );
  console.log('6 Core Events (7-Day Window / All-Time):');
  for (const [ev, count7d] of Object.entries(summary.countsWindow)) {
    const countAll = summary.countsAllTime[ev] ?? 0;
    console.log(`  • ${ev.padEnd(22)} : ${String(count7d).padStart(4)} (7d)  |  ${String(countAll).padStart(5)} (all-time)`);
  }
}

import { spawnSync } from 'node:child_process';

/**
 * Install a macOS LaunchAgent (`~/Library/LaunchAgents/com.agent-annotator.hub.plist`)
 * so the Local Collector Hub (`127.0.0.1:17380`) stays running across reboots and terminal exits.
 */
export function runInstallLaunchAgent() {
  if (process.platform !== 'darwin') {
    console.log('ℹ️  LaunchAgent auto-start is only applicable on macOS.');
    return;
  }
  const label = 'com.agent-annotator.hub';
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const cliPath = path.resolve(__dirname, 'cli.js');
  const logPath = path.join(getDataDir(), 'hub-launchd.log');

  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plistXml, 'utf8');
  spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf8' });
  const loadRes = spawnSync('launchctl', ['load', '-w', plistPath], { encoding: 'utf8' });
  if (loadRes.status === 0) {
    console.log(`✅ Installed & started macOS LaunchAgent: ${plistPath}`);
    console.log(`   Hub will automatically stay alive on http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}/playground`);
  } else {
    console.log(`✅ Wrote LaunchAgent plist at ${plistPath}`);
  }
}

/**
 * Package the browser extension into a clean GitHub Release zip (`dist/agent-annotator-extension-v0.1.0.zip`).
 * Excludes `.pem`, `.crx`, and `.DS_Store`.
 */
export function runPackExtensionRelease() {
  const extDir = path.join(REPO_ROOT, 'packages', 'browser-extension');
  const distDir = path.join(REPO_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const zipName = `agent-annotator-extension-v${manifest.version}.zip`;
  const zipPath = path.join(distDir, zipName);
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  const filesToPack = [
    'manifest.json',
    'background.js',
    'annotator-content.js',
    'main-world-hook.js',
    'icon-16.png',
    'icon-32.png',
    'icon-48.png',
    'icon-128.png',
  ];
  const res = spawnSync('zip', ['-j', zipPath, ...filesToPack.map((f) => path.join(extDir, f))], {
    encoding: 'utf8',
  });

  if (res.status !== 0) {
    throw new Error(`Failed to create release zip: ${res.stderr || res.stdout}`);
  }

  const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`📦 Packaged GitHub Release extension archive: ${zipPath} (${sizeKb} KB)`);
  return { zipPath, sizeKb: Number(sizeKb) };
}

function printHelp() {
  console.log(`
Agent Annotator v0.1 — Universal UI Annotation Collector for Coding Agents

Usage:
  annotator serve                   Start Local Collector Hub (127.0.0.1:17380)
  annotator install-service         Install macOS LaunchAgent (auto-start Hub in background)
  annotator mcp                     Run stdio MCP Server
  annotator install-mcp [--dry-run] Configure MCP in Antigravity, Claude Code, Cursor & Codex
  annotator pack                    Build GitHub Release zip (dist/agent-annotator-extension-v0.1.0.zip)
  annotator doctor                  Check Hub, storage, extension & MCP health
  annotator stats                   View North Star metric & 6 core telemetry events
  annotator benchmark               Evaluate the 20-case UI bug benchmark gate
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
