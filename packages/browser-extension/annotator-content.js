/**
 * @fileoverview On-demand Shadow DOM Annotation Collector (`annotator-content.js`).
 *
 * Features (v0.1):
 *  - On-demand toggle via `activeTab` user gesture (`Alt+Shift+A` or extension toolbar icon).
 *  - Modes: Element Pick (`element`) + Region Drag (`region`) + Multi-marker batching (`1, 2, 3...`).
 *  - Extracts component source location (via main-world probe), concise 4-level CSS selector,
 *    4-level DOM tag path, ARIA role, target text, and landmark nearby text.
 *  - Single-Capture Multi-Crop: When the user finishes annotating, hides all floating controls,
 *    leaves ONLY the blue outlines (`#128dff`) and numbered markers (`1..N`) on screen, calls
 *    `captureVisibleTab` ONCE, and crops N individual 32px-padded screenshots in a single pass.
 */

(function runAgentAnnotatorContent() {
  const HOST_ID = '__agent_annotator_root_host__';
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost) {
    existingHost.dispatchEvent(new CustomEvent('__agent_annotator_toggle__'));
    return;
  }

  /** @type {'element' | 'region'} */
  let currentMode = 'element';
  /** @type {Array<{
   *   id: string,
   *   index: number,
   *   kind: 'element' | 'region',
   *   comment: string,
   *   browserContext: any,
   *   rect: { x: number, y: number, width: number, height: number },
   *   markerPoint: { x: number, y: number }
   * }>} */
  let annotations = [];
  /** @type {number | null} */
  let editingIndex = null;
  /** @type {Element | null} */
  let hoveredElement = null;
  /** @type {{ startX: number, startY: number, currentX: number, currentY: number } | null} */
  let dragState = null;
  let isCapturingScreenshot = false;
  let isImeComposing = false;
  let lastCompositionEndTime = 0;

  /**
   * Detect whether a keyboard event is part of an active or just-committed CJK IME composition
   * (e.g., pressing Enter in Chinese/Japanese IME to commit English letters, or Escape to dismiss candidate window).
   * @param {KeyboardEvent} ev
   */
  function isImeCompositionEvent(ev) {
    if (ev.isComposing || ev.keyCode === 229 || ev.which === 229) {
      return true;
    }
    if (isImeComposing) {
      return true;
    }
    // Some macOS IMEs fire compositionend a few milliseconds before the committing Enter/Escape keydown
    if (performance.now() - lastCompositionEndTime < 65) {
      return true;
    }
    return false;
  }

  // Create Top-Layer Host (uses Popover API when supported so modals/dialogs never obscure it)
  const host = document.createElement('div');
  host.id = HOST_ID;
  if ('popover' in HTMLElement.prototype) {
    host.setAttribute('popover', 'manual');
  }
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: 'none',
    background: 'transparent',
    pointerEvents: 'none',
    zIndex: '2147483647',
    overflow: 'visible',
  });

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .aa-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
    }
    /* Hover highlight box */
    .aa-hover-box {
      position: fixed;
      border: 2px dashed #128dff;
      background: rgba(18, 141, 255, 0.08);
      border-radius: 4px;
      pointer-events: none;
      box-sizing: border-box;
      transition: all 40ms ease-out;
    }
    .aa-hover-label {
      position: absolute;
      top: -24px;
      left: -2px;
      background: #128dff;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0,0,0,0.18);
    }
    /* Locked annotation outline (kept visible during screenshot capture!) */
    .aa-outline-box {
      position: fixed;
      border: 2px solid #128dff;
      background: rgba(18, 141, 255, 0.04);
      border-radius: 4px;
      pointer-events: none;
      box-sizing: border-box;
    }
    /* Numbered comment marker badge (kept visible during screenshot capture!) */
    .aa-marker {
      position: fixed;
      width: 24px;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      border-radius: 999px;
      background: #128dff;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(18, 141, 255, 0.45), 0 0 0 2px #ffffff;
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
    }
    /* Floating top toolbar (hidden during screenshot capture) */
    .aa-toolbar {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(20, 22, 26, 0.94);
      backdrop-filter: blur(10px);
      color: #f3f4f6;
      padding: 6px 12px;
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.12);
      pointer-events: auto;
      font-size: 12px;
    }
    .aa-btn {
      appearance: none;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: #e5e7eb;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 120ms;
    }
    .aa-btn:hover {
      background: rgba(255, 255, 255, 0.18);
    }
    .aa-btn.active {
      background: #128dff;
      color: #ffffff;
      font-weight: 600;
    }
    .aa-btn.primary {
      background: #10b981;
      color: #ffffff;
      font-weight: 600;
    }
    .aa-btn.primary:hover {
      background: #059669;
    }
    /* Comment input card (hidden during screenshot capture) */
    .aa-card {
      position: fixed;
      width: 300px;
      background: #181a1f;
      color: #f3f4f6;
      border-radius: 10px;
      padding: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.14);
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .aa-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #9ca3af;
    }
    .aa-card-meta {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #60a5fa;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
    }
    .aa-textarea {
      width: 100%;
      min-height: 64px;
      box-sizing: border-box;
      background: #0f1115;
      color: #f9fafb;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 7px 8px;
      font-size: 12px;
      line-height: 1.4;
      resize: vertical;
      outline: none;
    }
    .aa-textarea:focus {
      border-color: #128dff;
    }
    .aa-card-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .aa-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #111827;
      color: #fff;
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      pointer-events: none;
    }
  `;

  const markersLayer = document.createElement('div');
  markersLayer.className = 'aa-layer';

  const hoverBox = document.createElement('div');
  hoverBox.className = 'aa-hover-box';
  hoverBox.style.display = 'none';
  const hoverLabel = document.createElement('div');
  hoverLabel.className = 'aa-hover-label';
  hoverBox.appendChild(hoverLabel);

  const uiChromeLayer = document.createElement('div');
  uiChromeLayer.className = 'aa-layer';

  shadow.append(styleEl, markersLayer, hoverBox, uiChromeLayer);
  document.documentElement.appendChild(host);
  try {
    host.showPopover?.();
  } catch {
    // Fallback to fixed z-index
  }

  // ==================== DOM & Component Feature Extraction ====================

  function cssEscapeIdent(str) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    return str.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  /**
   * Build a concise 4-level CSS selector (mirrors Codex's `Cc` / `wc` logic).
   * @param {Element} el
   */
  function buildTargetSelector(el) {
    const parts = [];
    let curr = el;
    let depth = 0;
    while (curr && depth < 4 && curr.nodeType === Node.ELEMENT_NODE) {
      let seg = curr.tagName.toLowerCase();
      if (curr.id) {
        seg += `#${cssEscapeIdent(curr.id)}`;
        parts.unshift(seg);
        break;
      }
      const classes = Array.from(curr.classList)
        .filter((c) => /^[a-zA-Z0-9_-]+$/.test(c))
        .slice(0, 2);
      if (classes.length > 0) {
        seg += `.${classes.map(cssEscapeIdent).join('.')}`;
      }
      const parent = curr.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === curr.tagName
        );
        if (sameTagSiblings.length > 1) {
          seg += `:nth-of-type(${sameTagSiblings.indexOf(curr) + 1})`;
        }
      }
      parts.unshift(seg);
      curr = parent;
      depth += 1;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  /**
   * Build a 4-level tag path (e.g. `main > section > div > button`).
   * @param {Element} el
   */
  function buildTargetPath(el) {
    const parts = [];
    let curr = el;
    let depth = 0;
    while (curr && depth < 4 && curr.nodeType === Node.ELEMENT_NODE) {
      const tag = curr.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') {
        if (parts.length === 0) parts.unshift(tag);
        break;
      }
      parts.unshift(tag);
      curr = curr.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function extractShortText(el) {
    if (!el) return null;
    const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return raw.length > 0 ? raw.slice(0, 80) : null;
  }

  function extractTargetLabel(el) {
    return el.getAttribute('aria-label') || extractShortText(el) || el.tagName.toLowerCase();
  }

  function extractNearbyText(el) {
    const own = extractShortText(el);
    if (own) return own;
    const landmark = el.closest('section,article,main,form,nav,aside,header,footer');
    return landmark ? extractShortText(landmark) : null;
  }

  /**
   * Query the main-world hook for React/Vue/Svelte component & file:line metadata.
   * @param {Element} el
   */
  function probeComponentContext(el) {
    const ATTR_NAME = 'data-agent-annotator-probe-result';
    try {
      el.removeAttribute(ATTR_NAME);
      el.dispatchEvent(new CustomEvent('__agent_annotator_probe__', { bubbles: true }));
      const raw = el.getAttribute(ATTR_NAME);
      el.removeAttribute(ATTR_NAME);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {
      // Ignore
    }
    return undefined;
  }

  function detectBrowserFamily() {
    const ua = navigator.userAgent;
    if (ua.includes('Edg/')) return 'edge';
    if (getComputedStyle(document.documentElement).getPropertyValue('--arc-palette-title')) return 'arc';
    if (ua.includes('Chrome/')) return 'chrome';
    return 'chromium';
  }

  // ==================== Position Sync & Rendering ====================

  function clampMarkerPoint(pt) {
    const pad = 14;
    return {
      x: Math.max(pad, Math.min(window.innerWidth - pad, Math.round(pt.x))),
      y: Math.max(pad, Math.min(window.innerHeight - pad, Math.round(pt.y))),
    };
  }

  /**
   * Keep annotation rectangles and marker pins aligned with the DOM even if the user scrolls
   * or resizes the viewport between placing Marker #1 and clicking Copy & Send.
   */
  function syncAnnotationPositions() {
    for (const ann of annotations) {
      if (ann.kind === 'element' && ann.targetElement && ann.targetElement.isConnected) {
        const r = ann.targetElement.getBoundingClientRect();
        ann.rect = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
        const dx = ann.markerOffset?.dx ?? Math.min(20, Math.round(r.width / 2));
        const dy = ann.markerOffset?.dy ?? Math.min(20, Math.round(r.height / 2));
        ann.markerPoint = clampMarkerPoint({
          x: r.left + dx,
          y: r.top + dy,
        });
      } else if (typeof ann.pageX === 'number' && typeof ann.pageY === 'number') {
        const nextX = Math.round(ann.pageX - window.scrollX);
        const nextY = Math.round(ann.pageY - window.scrollY);
        const shiftX = nextX - ann.rect.x;
        const shiftY = nextY - ann.rect.y;
        ann.rect.x = nextX;
        ann.rect.y = nextY;
        ann.markerPoint = clampMarkerPoint({
          x: ann.markerPoint.x + shiftX,
          y: ann.markerPoint.y + shiftY,
        });
      }
      ann.browserContext.targetRect = { ...ann.rect };
      ann.browserContext.markerViewportPoint = { ...ann.markerPoint };
      ann.browserContext.viewportSize = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
    }
  }

  /**
   * Update outline boxes, marker pins, and comment card coordinates in-place
   * WITHOUT destroying/recreating the comment card or losing textarea focus/IME state.
   */
  function updatePositionsOnly() {
    if (isCapturingScreenshot) return;
    syncAnnotationPositions();

    const boxes = markersLayer.querySelectorAll('.aa-outline-box');
    const pins = markersLayer.querySelectorAll('.aa-marker');
    if (boxes.length !== annotations.length || pins.length !== annotations.length) {
      renderMarkersOnly();
    } else {
      annotations.forEach((ann, i) => {
        Object.assign(boxes[i].style, {
          left: `${ann.rect.x}px`,
          top: `${ann.rect.y}px`,
          width: `${ann.rect.width}px`,
          height: `${ann.rect.height}px`,
        });
        Object.assign(pins[i].style, {
          left: `${ann.markerPoint.x}px`,
          top: `${ann.markerPoint.y}px`,
        });
      });
    }

    const activeAnn = annotations.find((a) => a.index === editingIndex);
    const activeCard = uiChromeLayer.querySelector('.aa-card');
    if (activeAnn && activeCard) {
      const cardLeft = Math.min(
        Math.max(12, activeAnn.markerPoint.x + 16),
        window.innerWidth - 320
      );
      const cardTop = Math.min(
        Math.max(56, activeAnn.markerPoint.y - 12),
        window.innerHeight - 170
      );
      activeCard.style.left = `${cardLeft}px`;
      activeCard.style.top = `${cardTop}px`;
    }
  }

  function renderMarkersOnly() {
    markersLayer.replaceChildren();
    for (const ann of annotations) {
      const box = document.createElement('div');
      box.className = 'aa-outline-box';
      Object.assign(box.style, {
        left: `${ann.rect.x}px`,
        top: `${ann.rect.y}px`,
        width: `${ann.rect.width}px`,
        height: `${ann.rect.height}px`,
      });
      markersLayer.appendChild(box);

      const pin = document.createElement('div');
      pin.className = 'aa-marker';
      pin.textContent = String(ann.index);
      Object.assign(pin.style, {
        left: `${ann.markerPoint.x}px`,
        top: `${ann.markerPoint.y}px`,
      });
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingIndex === ann.index) return;
        editingIndex = ann.index;
        renderAll();
      });
      markersLayer.appendChild(pin);
    }
  }

  function renderAll() {
    syncAnnotationPositions();

    // 1. Render locked outlines + numbered pins in markersLayer
    renderMarkersOnly();

    // 2. Render toolbar & active comment editor card in uiChromeLayer (hidden during screenshot!)
    uiChromeLayer.replaceChildren();
    if (isCapturingScreenshot) {
      hoverBox.style.display = 'none';
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'aa-toolbar';

    const hintSpan = document.createElement('span');
    hintSpan.textContent = '🎯 Click element · 📐 Drag region';
    hintSpan.style.color = '#9ca3af';
    hintSpan.style.padding = '0 6px 0 4px';
    hintSpan.style.borderRight = '1px solid rgba(255, 255, 255, 0.14)';

    const countSpan = document.createElement('span');
    countSpan.textContent = `${annotations.length} marked`;
    countSpan.style.padding = '0 4px';
    countSpan.style.fontWeight = '600';

    const finishBtn = document.createElement('button');
    finishBtn.className = 'aa-btn primary';
    finishBtn.textContent =
      annotations.length > 0 ? `✓ Copy Prompt (${annotations.length})` : '✓ Copy Prompt';
    finishBtn.disabled = annotations.length === 0;
    finishBtn.style.opacity = annotations.length === 0 ? '0.5' : '1';
    finishBtn.onclick = (e) => {
      e.stopPropagation();
      finishAndSubmitBatch('prompt');
    };

    const copyImgBtn = document.createElement('button');
    copyImgBtn.className = 'aa-btn';
    copyImgBtn.textContent = '🖼️ Copy PNG';
    copyImgBtn.disabled = annotations.length === 0;
    copyImgBtn.style.opacity = annotations.length === 0 ? '0.5' : '1';
    copyImgBtn.onclick = (e) => {
      e.stopPropagation();
      finishAndSubmitBatch('image');
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'aa-btn';
    closeBtn.textContent = '✕ Esc';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      cleanupAndExit();
    };

    toolbar.append(hintSpan, countSpan, finishBtn, copyImgBtn, closeBtn);
    uiChromeLayer.appendChild(toolbar);

    // Active comment editor card
    const activeAnn = annotations.find((a) => a.index === editingIndex);
    if (activeAnn) {
      const card = document.createElement('div');
      card.className = 'aa-card';
      const cardLeft = Math.min(
        Math.max(12, activeAnn.markerPoint.x + 16),
        window.innerWidth - 320
      );
      const cardTop = Math.min(
        Math.max(56, activeAnn.markerPoint.y - 12),
        window.innerHeight - 170
      );
      Object.assign(card.style, {
        left: `${cardLeft}px`,
        top: `${cardTop}px`,
      });

      const header = document.createElement('div');
      header.className = 'aa-card-header';
      const title = document.createElement('span');
      title.textContent = `Annotation #${activeAnn.index}`;
      const meta = document.createElement('span');
      meta.className = 'aa-card-meta';
      const comp = activeAnn.browserContext.componentContext;
      meta.textContent = comp?.componentName
        ? `<${comp.componentName}>`
        : activeAnn.browserContext.targetSelector || activeAnn.kind;
      header.append(title, meta);

      const textarea = document.createElement('textarea');
      textarea.className = 'aa-textarea';
      textarea.placeholder = 'What should the Agent fix or change here? (Cmd+Enter to finish all)';
      textarea.value = activeAnn.comment;
      textarea.addEventListener('compositionstart', () => {
        isImeComposing = true;
      });
      textarea.addEventListener('compositionend', (ev) => {
        isImeComposing = false;
        lastCompositionEndTime = performance.now();
        activeAnn.comment = ev.target.value;
      });
      textarea.addEventListener('input', (ev) => {
        activeAnn.comment = ev.target.value;
      });
      textarea.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (isImeCompositionEvent(ev)) {
          return;
        }
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.preventDefault();
          finishAndSubmitBatch('prompt');
        } else if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          editingIndex = null;
          renderAll();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          editingIndex = null;
          renderAll();
        }
      });

      const actions = document.createElement('div');
      actions.className = 'aa-card-actions';

      const delBtn = document.createElement('button');
      delBtn.className = 'aa-btn';
      delBtn.textContent = 'Delete';
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        annotations = annotations
          .filter((a) => a.index !== activeAnn.index)
          .map((a, idx) => ({ ...a, index: idx + 1 }));
        editingIndex = null;
        renderAll();
      };

      const doneBtn = document.createElement('button');
      doneBtn.className = 'aa-btn active';
      doneBtn.textContent = 'Save Marker (Enter)';
      doneBtn.onclick = (ev) => {
        ev.stopPropagation();
        editingIndex = null;
        renderAll();
      };

      actions.append(delBtn, doneBtn);
      card.append(header, textarea, actions);
      card.addEventListener('mousedown', (ev) => ev.stopPropagation());
      card.addEventListener('mouseup', (ev) => ev.stopPropagation());
      card.addEventListener('click', (ev) => ev.stopPropagation());
      uiChromeLayer.appendChild(card);
      requestAnimationFrame(() => {
        textarea.focus({ preventScroll: true });
      });
    }
  }

  // ==================== Single-Capture Multi-Crop Engine ====================

  /**
   * Wait two animation frames + 40ms so the browser compositor flushes DOM changes before `captureVisibleTab`.
   */
  function waitForPaintFlush() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, 40);
        });
      });
    });
  }

  /**
   * Load a DataURL into an HTMLImageElement.
   * @param {string} dataUrl
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode viewport screenshot'));
      img.src = dataUrl;
    });
  }

  /**
   * Given 1 full-viewport screenshot and N annotations, crop each annotation's
   * `(targetRect ∪ markerPoint) + 32px padding` (clamped strictly to viewport bounds, scaled <= 1024px).
   * Guarantees zero black borders and zero out-of-bounds clamping across Retina DPR & browser zoom.
   *
   * @param {string} viewportDataUrl
   * @param {typeof annotations} items
   */
  async function cropMultipleFromSingleScreenshot(viewportDataUrl, items) {
    const img = await loadImage(viewportDataUrl);
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const imgW = Math.max(1, img.naturalWidth);
    const imgH = Math.max(1, img.naturalHeight);
    const scaleX = imgW / vw;
    const scaleY = imgH / vh;
    const PADDING_CSS_PX = 32;
    const MAX_DIMENSION = 1024;
    const MIN_CROP_CSS_PX = 16;

    return items.map((ann) => {
      // Union of target rect and 24x24 marker pin (with 2px white ring => 28x28)
      const markerBox = {
        x: ann.markerPoint.x - 14,
        y: ann.markerPoint.y - 14,
        width: 28,
        height: 28,
      };
      let minX = Math.min(ann.rect.x, markerBox.x) - PADDING_CSS_PX;
      let minY = Math.min(ann.rect.y, markerBox.y) - PADDING_CSS_PX;
      let maxX =
        Math.max(ann.rect.x + ann.rect.width, markerBox.x + markerBox.width) + PADDING_CSS_PX;
      let maxY =
        Math.max(ann.rect.y + ann.rect.height, markerBox.y + markerBox.height) + PADDING_CSS_PX;

      // Strictly clamp within [0, vw] x [0, vh]
      minX = Math.max(0, Math.min(vw, minX));
      maxX = Math.max(0, Math.min(vw, maxX));
      minY = Math.max(0, Math.min(vh, minY));
      maxY = Math.max(0, Math.min(vh, maxY));

      // Enforce minimum CSS crop size by expanding inward (never overflowing right/bottom viewport edge)
      const targetMinW = Math.min(vw, MIN_CROP_CSS_PX);
      if (maxX - minX < targetMinW) {
        if (minX + targetMinW <= vw) {
          maxX = minX + targetMinW;
        } else {
          maxX = vw;
          minX = Math.max(0, vw - targetMinW);
        }
      }
      const targetMinH = Math.min(vh, MIN_CROP_CSS_PX);
      if (maxY - minY < targetMinH) {
        if (minY + targetMinH <= vh) {
          maxY = minY + targetMinH;
        } else {
          maxY = vh;
          minY = Math.max(0, vh - targetMinH);
        }
      }

      const cropCssW = maxX - minX;
      const cropCssH = maxY - minY;

      // Map start/end edges directly to physical image pixels so sx + sw <= imgW is always true
      const sx = Math.max(0, Math.min(imgW - 1, Math.round(minX * scaleX)));
      const sy = Math.max(0, Math.min(imgH - 1, Math.round(minY * scaleY)));
      const ex = Math.max(sx + 1, Math.min(imgW, Math.round(maxX * scaleX)));
      const ey = Math.max(sy + 1, Math.min(imgH, Math.round(maxY * scaleY)));
      const sw = ex - sx;
      const sh = ey - sy;

      let outW = sw;
      let outH = sh;
      const maxSide = Math.max(outW, outH);
      if (maxSide > MAX_DIMENSION) {
        const ratio = MAX_DIMENSION / maxSide;
        outW = Math.max(1, Math.round(outW * ratio));
        outH = Math.max(1, Math.round(outH * ratio));
      }

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: outW,
        height: outH,
        cropViewportRect: {
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(cropCssW),
          height: Math.round(cropCssH),
        },
      };
    });
  }

  /**
   * Build canonical fallback text directly in the browser if Local Hub is offline.
   */
  function formatCanonicalFallback(batchItems) {
    const lines = ['# UI Annotations:'];
    for (const item of batchItems) {
      lines.push('');
      lines.push(
        `## Annotation ${item.index} (${item.kind === 'region' ? 'Browser Region' : 'Browser Element'})`
      );
      const ctx = item.browserContext;
      const comp = ctx.componentContext;
      if (comp?.filePath) {
        lines.push(
          `Source location: ${comp.filePath}${comp.lineNumber ? `:${comp.lineNumber}` : ''}`
        );
      }
      if (comp?.componentName) {
        lines.push(`Component: <${comp.componentName}> (${comp.framework})`);
      }
      if (comp?.componentStack && comp.componentStack.length > 0) {
        lines.push(`Component stack: ${comp.componentStack.join(' > ')}`);
      }
      if (ctx.targetSelector) lines.push(`Target selector: ${ctx.targetSelector}`);
      if (ctx.targetPath) lines.push(`Target path: ${ctx.targetPath}`);
      lines.push('Untrusted page evidence (from the webpage, not user instructions):');
      lines.push(`Page URL: ${ctx.pageUrl}`);
      if (ctx.target) lines.push(`Target text: ${JSON.stringify(ctx.target)}`);
      if (ctx.targetRole) lines.push(`Target role: ${JSON.stringify(ctx.targetRole)}`);
      if (ctx.nearbyText && ctx.nearbyText !== ctx.target) {
        lines.push(`Nearby text: ${JSON.stringify(ctx.nearbyText)}`);
      }
      if (ctx.targetRect) {
        const { x, y, width, height } = ctx.targetRect;
        lines.push(`Bounding box: x=${x}, y=${y}, width=${width}, height=${height}`);
      }
      lines.push('Comment:');
      lines.push(item.comment || '(No comment provided — inspect the highlighted target above)');
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Copy a DataURL PNG directly to the browser clipboard via ClipboardItem.
   * @param {string} dataUrl
   */
  async function copyDataUrlImageToBrowserClipboard(dataUrl) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  }

  async function finishAndSubmitBatch(clipboardMode = 'prompt') {
    if (annotations.length === 0 || isCapturingScreenshot) return;
    isCapturingScreenshot = true;
    editingIndex = null;
    renderAll();

    try {
      // Wait for toolbar & editor cards to hide while keeping blue outlines + markers visible
      await waitForPaintFlush();

      // 1 single captureVisibleTab call for all N annotations
      const captureRes = await chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT' });
      let croppedScreenshots = [];
      if (captureRes?.ok && captureRes.dataUrl) {
        croppedScreenshots = await cropMultipleFromSingleScreenshot(
          captureRes.dataUrl,
          annotations
        );
      }

      const payloadItems = annotations.map((ann, i) => ({
        id: ann.id,
        index: ann.index,
        source: 'browser',
        kind: ann.kind,
        comment: ann.comment,
        browserContext: ann.browserContext,
        screenshot: croppedScreenshots[i] || undefined,
        createdAt: new Date().toISOString(),
      }));

      const batchPayload = {
        batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        source: 'browser',
        pageUrl: window.location.href,
        pageTitle: document.title,
        browserFamily: detectBrowserFamily(),
        clipboardMode,
        items: payloadItems,
      };

      const hubRes = await chrome.runtime.sendMessage({
        type: 'SUBMIT_BATCH',
        payload: batchPayload,
      });

      // Only notify the Hub's own playground, and never expose screenshots/paths/comments to page scripts.
      if (
        (location.hostname === '127.0.0.1' || location.hostname === 'localhost') &&
        location.pathname === '/playground'
      ) {
        window.dispatchEvent(
          new CustomEvent('__agent_annotator_batch_submitted__', {
            detail: { batchId: batchPayload.batchId, itemCount: payloadItems.length },
          })
        );
      }

      if (clipboardMode === 'image' && croppedScreenshots[0]?.dataUrl) {
        try {
          await copyDataUrlImageToBrowserClipboard(croppedScreenshots[0].dataUrl);
        } catch {
          // Hub osascript already copied PNG on macOS if online
        }
        showToastAndExit(`Copied annotated PNG image to clipboard!`);
        return;
      }

      if (hubRes?.ok && hubRes.formatted?.text) {
        // Also write to browser clipboard to guarantee availability
        try {
          await navigator.clipboard.writeText(hubRes.formatted.text);
        } catch {
          // Hub pbcopy already wrote it on macOS
        }
        showToastAndExit(`Copied ${annotations.length} annotation(s) + saved PNGs for Agent!`);
      } else {
        // Offline fallback: copy canonical text in browser
        const fallbackText = formatCanonicalFallback(payloadItems);
        await navigator.clipboard.writeText(fallbackText);
        showToastAndExit(`Copied ${annotations.length} annotation(s) to clipboard (Hub offline)`);
      }
    } catch (err) {
      isCapturingScreenshot = false;
      renderAll();
      console.error('[AgentAnnotator] Failed to finish batch:', err);
    }
  }

  function showToastAndExit(message) {
    markersLayer.replaceChildren();
    uiChromeLayer.replaceChildren();
    hoverBox.style.display = 'none';
    const toast = document.createElement('div');
    toast.className = 'aa-toast';
    toast.textContent = `✅ ${message}`;
    shadow.appendChild(toast);
    setTimeout(() => {
      cleanupAndExit();
    }, 1200);
  }

  // ==================== Mouse & Keyboard Event Listeners ====================

  function isEventInsideAnnotatorUI(e) {
    const path = e.composedPath?.() || [];
    return path.includes(uiChromeLayer) || path.includes(markersLayer);
  }

  const DRAG_THRESHOLD_PX = 6;

  let hoveredTagLabel = '';
  let hoverProbeTimer = 0;
  let moveRafId = 0;
  let pendingMoveEvent = null;
  /** Coalesce mousemove to at most one handler run per animation frame. */
  function onMouseMoveThrottled(e) {
    // composedPath() is only valid during dispatch, so resolve it now.
    pendingMoveEvent = { x: e.clientX, y: e.clientY, inside: isEventInsideAnnotatorUI(e) };
    if (moveRafId) return;
    moveRafId = requestAnimationFrame(() => {
      moveRafId = 0;
      const ev = pendingMoveEvent;
      pendingMoveEvent = null;
      if (ev) onMouseMove({ clientX: ev.x, clientY: ev.y }, ev.inside);
    });
  }

  function onMouseMove(e, insideUI = isEventInsideAnnotatorUI(e)) {
    if (isCapturingScreenshot) return;
    if (insideUI && !dragState) {
      hoverBox.style.display = 'none';
      return;
    }

    // If mouse button is pressed, check if pointer moved >= 6px to transition into Region Drag
    if (dragState) {
      dragState.currentX = e.clientX;
      dragState.currentY = e.clientY;
      const dx = Math.abs(dragState.currentX - dragState.startX);
      const dy = Math.abs(dragState.currentY - dragState.startY);
      if (!dragState.isDraggingRegion && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragState.isDraggingRegion = true;
      }
      if (dragState.isDraggingRegion) {
        const x = Math.min(dragState.startX, dragState.currentX);
        const y = Math.min(dragState.startY, dragState.currentY);
        const w = Math.abs(dragState.currentX - dragState.startX);
        const h = Math.abs(dragState.currentY - dragState.startY);
        Object.assign(hoverBox.style, {
          display: 'block',
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${h}px`,
        });
        hoverLabel.textContent = `📐 ${Math.round(w)} × ${Math.round(h)}`;
        return;
      }
    }

    // Default hover: highlight DOM element under cursor
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === document.documentElement || el === document.body) {
      hoverBox.style.display = 'none';
      hoveredElement = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hoverBox.style.display = 'none';
      return;
    }
    if (el !== hoveredElement) {
      hoveredElement = el;
      // Cheap label immediately; the component probe mutates page DOM attributes (can trigger
      // page MutationObservers / style recalcs), so run it only once the cursor settles.
      hoveredTagLabel = el.tagName.toLowerCase();
      clearTimeout(hoverProbeTimer);
      hoverProbeTimer = setTimeout(() => {
        if (hoveredElement !== el || dragState) return;
        const comp = probeComponentContext(el);
        hoveredTagLabel = comp?.componentName
          ? `<${comp.componentName}> ${el.tagName.toLowerCase()}`
          : buildTargetSelector(el).split(' > ').pop();
        hoverLabel.textContent = hoveredTagLabel;
      }, 120);
    }

    Object.assign(hoverBox.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    hoverLabel.textContent = hoveredTagLabel;
  }

  function onMouseDown(e) {
    if (isCapturingScreenshot || e.button !== 0 || isEventInsideAnnotatorUI(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      isDraggingRegion: false,
    };
  }

  function onMouseUp(e) {
    if (isCapturingScreenshot || e.button !== 0 || !dragState) return;
    e.preventDefault();
    e.stopPropagation();

    const finished = dragState;
    dragState = null;
    hoverBox.style.display = 'none';

    // Case 1: Dragged >= 6px => Create Region Annotation
    if (finished.isDraggingRegion) {
      const x = Math.round(Math.min(finished.startX, finished.currentX));
      const y = Math.round(Math.min(finished.startY, finished.currentY));
      const width = Math.round(Math.abs(finished.currentX - finished.startX));
      const height = Math.round(Math.abs(finished.currentY - finished.startY));
      if (width < 8 || height < 8) return;

      const centerEl = document.elementFromPoint(x + width / 2, y + height / 2);
      const nextIdx = annotations.length + 1;
      const rect = { x, y, width, height };
      const markerPoint = clampMarkerPoint({ x: x + width, y });
      const regionText = centerEl ? extractShortText(centerEl) : null;

      annotations.push({
        id: `ann_${Date.now()}_${nextIdx}`,
        index: nextIdx,
        kind: 'region',
        comment: '',
        rect,
        markerPoint,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY,
        browserContext: {
          pageUrl: window.location.href,
          target: regionText || 'Selected browser region',
          targetRole: centerEl?.getAttribute('role') || null,
          targetSelector: centerEl ? buildTargetSelector(centerEl) : null,
          targetPath: centerEl ? buildTargetPath(centerEl) : null,
          nearbyText: centerEl ? extractNearbyText(centerEl) : null,
          targetRect: rect,
          markerViewportPoint: markerPoint,
          viewportSize: { width: window.innerWidth, height: window.innerHeight },
          themeVariant: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
            ? 'dark'
            : 'light',
          componentContext: centerEl ? probeComponentContext(centerEl) : undefined,
        },
      });
      editingIndex = nextIdx;
      renderAll();
      return;
    }

    // Case 2: Clicked without dragging (< 6px movement) => Create Element Annotation
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === document.documentElement || el === document.body) return;

    const r = el.getBoundingClientRect();
    const rect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    const markerPoint = clampMarkerPoint({
      x: e.clientX,
      y: e.clientY,
    });
    const nextIdx = annotations.length + 1;
    const comp = probeComponentContext(el);

    annotations.push({
      id: `ann_${Date.now()}_${nextIdx}`,
      index: nextIdx,
      kind: 'element',
      comment: '',
      rect,
      markerPoint,
      targetElement: el,
      markerOffset: {
        dx: markerPoint.x - rect.x,
        dy: markerPoint.y - rect.y,
      },
      pageX: rect.x + window.scrollX,
      pageY: rect.y + window.scrollY,
      browserContext: {
        pageUrl: window.location.href,
        target: extractTargetLabel(el),
        targetRole: el.getAttribute('role') || null,
        targetSelector: buildTargetSelector(el),
        targetPath: buildTargetPath(el),
        nearbyText: extractNearbyText(el),
        targetRect: rect,
        markerViewportPoint: markerPoint,
        viewportSize: { width: window.innerWidth, height: window.innerHeight },
        themeVariant: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
          ? 'dark'
          : 'light',
        componentContext: comp,
      },
    });
    editingIndex = nextIdx;
    renderAll();
  }

  function onClick(e) {
    if (isCapturingScreenshot || isEventInsideAnnotatorUI(e)) return;
    // Swallow native click so underlying host page links/buttons never fire while annotating
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
  }

  function onFocusTrapGuard(e) {
    if (isEventInsideAnnotatorUI(e)) {
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }
  }

  function onViewportChange(e) {
    if (isCapturingScreenshot) return;
    if (e && isEventInsideAnnotatorUI(e)) return;
    if (annotations.length > 0) {
      updatePositionsOnly();
    }
  }

  function onKeyDown(e) {
    if (isImeCompositionEvent(e)) {
      return;
    }
    if (isEventInsideAnnotatorUI(e)) {
      return;
    }
    if (e.key === 'Escape') {
      if (editingIndex !== null) {
        editingIndex = null;
        renderAll();
      } else {
        cleanupAndExit();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && annotations.length > 0) {
      e.preventDefault();
      finishAndSubmitBatch('prompt');
    }
  }

  function cleanupAndExit() {
    window.removeEventListener('mousemove', onMouseMoveThrottled, true);
    cancelAnimationFrame(moveRafId);
    clearTimeout(hoverProbeTimer);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('focusin', onFocusTrapGuard, true);
    window.removeEventListener('focusout', onFocusTrapGuard, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    annotations = [];
    hoveredElement = null;
    dragState = null;
    editingIndex = null;
    host.remove();
  }

  host.addEventListener('__agent_annotator_toggle__', () => {
    cleanupAndExit();
  });

  window.addEventListener('mousemove', onMouseMoveThrottled, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('focusin', onFocusTrapGuard, true);
  window.addEventListener('focusout', onFocusTrapGuard, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);

  renderAll();
})();
