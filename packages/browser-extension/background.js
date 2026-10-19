/**
 * @fileoverview Background Service Worker for Agent Annotator (v0.1).
 *
 * Uses `activeTab` + `chrome.scripting.executeScript` on-demand injection triggered by
 * user gesture (toolbar icon click or `Alt+Shift+A` shortcut).
 * Performs a single `captureVisibleTab` call when the user finishes a batch of annotations.
 */

const HUB_BASE_URL = 'http://127.0.0.1:17380';

/**
 * Inject main-world component hook + isolated Shadow DOM annotation UI into the active tab.
 * @param {chrome.tabs.Tab} tab
 */
async function toggleAnnotatorInTab(tab) {
  if (!tab?.id || !tab.url || /^(chrome|edge|arc|about|chrome-extension):/i.test(tab.url)) {
    return;
  }

  try {
    // 1. Inject lightweight React/Vue/Svelte fiber probe in MAIN world (idempotent)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['main-world-hook.js'],
    });

    // 2. Inject or toggle the isolated Shadow DOM annotator overlay
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      files: ['annotator-content.js'],
    });
  } catch (err) {
    console.warn('[AgentAnnotator] Failed to inject into activeTab:', err);
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggleAnnotatorInTab(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-annotation') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      toggleAnnotatorInTab(tab);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // Single-capture request: captures the visible viewport ONCE for all N annotations on the page
  if (message.type === 'CAPTURE_VIEWPORT') {
    const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError?.message || 'captureVisibleTab failed',
        });
        return;
      }
      sendResponse({ ok: true, dataUrl });
    });
    return true; // Async response
  }

  // Submit completed batch to Local Collector Hub (127.0.0.1:17380)
  if (message.type === 'SUBMIT_BATCH') {
    fetch(`${HUB_BASE_URL}/api/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(async (res) => {
        const data = await res.json();
        sendResponse(data);
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          offline: true,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true; // Async response
  }

  // Forward anonymous telemetry event when running in browser-only fallback mode
  if (message.type === 'TRACK_TELEMETRY') {
    fetch(`${HUB_BASE_URL}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
