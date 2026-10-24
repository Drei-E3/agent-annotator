/**
 * @fileoverview Dual-channel Clipboard Engine (Prompt text + PNG image) for macOS / cross-platform.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Copy formatted prompt text (which includes local PNG paths) to the system clipboard.
 * @param {string} text
 * @returns {{ ok: boolean, error?: string }}
 */
export function copyTextToClipboard(text) {
  if (process.platform === 'darwin') {
    const res = spawnSync('pbcopy', [], {
      input: text,
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    if (res.status === 0) {
      return { ok: true };
    }
    return { ok: false, error: res.stderr || 'pbcopy exited with non-zero status' };
  }
  return { ok: false, error: `Unsupported platform for native clipboard: ${process.platform}` };
}

/**
 * Copy a local PNG file directly into the macOS system clipboard as a native PNG image
 * (so users can also paste the image bitmap directly if desired).
 * @param {string} pngFilePath
 * @returns {{ ok: boolean, error?: string }}
 */
export function copyPngFileToClipboard(pngFilePath) {
  if (!fs.existsSync(pngFilePath)) {
    return { ok: false, error: `PNG file does not exist: ${pngFilePath}` };
  }
  if (process.platform === 'darwin') {
    const script = `set the clipboard to (read (POSIX file ${JSON.stringify(pngFilePath)}) as «class PNGf»)`;
    const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    if (res.status === 0) {
      return { ok: true };
    }
    return { ok: false, error: res.stderr || 'osascript failed to copy PNG' };
  }
  return { ok: false, error: `Unsupported platform: ${process.platform}` };
}
