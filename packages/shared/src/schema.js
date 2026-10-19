/**
 * @fileoverview Stable schema definitions and runtime validators for Universal Agent Annotator (v0.1).
 * Includes Day-1 protocol support for both 'browser' and 'desktop' (macOS AXTree) sources.
 */

export const SUPPORTED_SOURCES = /** @type {const} */ (['browser', 'desktop']);
export const SUPPORTED_KINDS = /** @type {const} */ (['element', 'region']);

/**
 * @typedef {Object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} ComponentContext
 * @property {'react' | 'vue' | 'svelte' | 'unknown'} framework
 * @property {string} [componentName]
 * @property {string} [filePath]
 * @property {number} [lineNumber]
 * @property {number} [columnNumber]
 * @property {string[]} [componentStack]
 */

/**
 * @typedef {Object} BrowserContext
 * @property {string} pageUrl
 * @property {string[]} [framePath]
 * @property {string | null} [frameUrl]
 * @property {string | null} [target]           - Primary label (aria-label or trimmed text <= 80 chars)
 * @property {string | null} [targetRole]       - Explicit or implicit ARIA role
 * @property {string | null} [targetSelector]   - Unique/concise 4-level CSS selector (with shadow: support)
 * @property {string | null} [targetPath]       - 4-level tag path (e.g. "main > section > div > button")
 * @property {string | null} [nearbyText]       - Landmark contextual text (<= 80 chars)
 * @property {Rect} [targetRect]                - Bounding box in viewport CSS px
 * @property {Point} [markerViewportPoint]      - Pin marker coordinate in viewport CSS px
 * @property {{ width: number, height: number }} [viewportSize]
 * @property {'light' | 'dark'} [themeVariant]
 * @property {ComponentContext} [componentContext]
 */

/**
 * @typedef {Object} AXContext
 * @property {string} appName
 * @property {string} bundleIdentifier
 * @property {string} [windowTitle]
 * @property {string} [role]                    - e.g. "AXButton"
 * @property {string} [subrole]
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [identifier]              - AXIdentifier
 * @property {string} [value]
 * @property {Rect} [bounds]
 * @property {string} [axTree]                  - Compact accessibility tree around selected node
 */

/**
 * @typedef {Object} ScreenshotPayload
 * @property {string} [dataUrl]                 - data:image/png;base64,...
 * @property {string} [localPath]               - Populated by Local Hub after saving to disk
 * @property {number} [width]
 * @property {number} [height]
 * @property {Rect} [cropViewportRect]
 */

/**
 * @typedef {Object} AnnotationItem
 * @property {string} id
 * @property {number} index                     - 1-based marker number (1, 2, 3...)
 * @property {'browser' | 'desktop'} source
 * @property {'element' | 'region'} kind
 * @property {string} comment                   - User's instruction / note for this marker
 * @property {BrowserContext} [browserContext]  - Present when source === 'browser'
 * @property {AXContext} [axContext]            - Present when source === 'desktop' (reserved for macOS collector)
 * @property {ScreenshotPayload} [screenshot]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} AnnotationBatch
 * @property {string} batchId
 * @property {'browser' | 'desktop' | 'mixed'} source
 * @property {string} createdAt
 * @property {string} [pageUrl]
 * @property {string} [pageTitle]
 * @property {string} [browserFamily]
 * @property {AnnotationItem[]} items
 */

/**
 * Validate and normalize an incoming AnnotationBatch payload.
 * @param {any} raw
 * @returns {{ ok: true, data: AnnotationBatch } | { ok: false, error: string }}
 */
export function validateAnnotationBatch(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Batch payload must be an object' };
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return { ok: false, error: 'Batch must contain at least one annotation item' };
  }
  if (raw.items.length > 50) {
    return { ok: false, error: 'Batch exceeds maximum of 50 items' };
  }

  const batchId =
    typeof raw.batchId === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(raw.batchId)
      ? raw.batchId
      : `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  /** @type {AnnotationItem[]} */
  const normalizedItems = [];

  for (let i = 0; i < raw.items.length; i++) {
    const item = raw.items[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `Item at index ${i} is invalid` };
    }
    const source = item.source === 'desktop' ? 'desktop' : 'browser';
    const kind = item.kind === 'region' ? 'region' : 'element';
    const index = Number.isSafeInteger(item.index) && item.index > 0 ? item.index : i + 1;
    const comment = typeof item.comment === 'string' ? item.comment.trim() : '';

    if (source === 'browser' && (!item.browserContext || typeof item.browserContext !== 'object')) {
      return { ok: false, error: `Browser item ${index} is missing browserContext` };
    }
    if (source === 'desktop' && (!item.axContext || typeof item.axContext !== 'object')) {
      return { ok: false, error: `Desktop item ${index} is missing axContext` };
    }

    normalizedItems.push({
      id: typeof item.id === 'string' && item.id ? item.id : `ann_${index}`,
      index,
      source,
      kind,
      comment,
      browserContext: source === 'browser' ? sanitizeBrowserContext(item.browserContext) : undefined,
      axContext: source === 'desktop' ? sanitizeAXContext(item.axContext) : undefined,
      screenshot: item.screenshot ? sanitizeScreenshot(item.screenshot) : undefined,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    });
  }

  const sources = new Set(normalizedItems.map((it) => it.source));
  const batchSource = sources.size > 1 ? 'mixed' : normalizedItems[0].source;

  return {
    ok: true,
    data: {
      batchId,
      source: batchSource,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      pageUrl: typeof raw.pageUrl === 'string' ? raw.pageUrl : normalizedItems[0]?.browserContext?.pageUrl,
      pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle : undefined,
      browserFamily: typeof raw.browserFamily === 'string' ? raw.browserFamily : undefined,
      items: normalizedItems,
    },
  };
}

/**
 * @param {any} ctx
 * @returns {BrowserContext}
 */
function sanitizeBrowserContext(ctx) {
  const comp = ctx.componentContext;
  return {
    pageUrl: typeof ctx.pageUrl === 'string' ? ctx.pageUrl : 'about:blank',
    framePath: Array.isArray(ctx.framePath) ? ctx.framePath.map(String) : [],
    frameUrl: typeof ctx.frameUrl === 'string' ? ctx.frameUrl : null,
    target: typeof ctx.target === 'string' ? ctx.target.slice(0, 120) : null,
    targetRole: typeof ctx.targetRole === 'string' ? ctx.targetRole.slice(0, 60) : null,
    targetSelector: typeof ctx.targetSelector === 'string' ? ctx.targetSelector.slice(0, 500) : null,
    targetPath: typeof ctx.targetPath === 'string' ? ctx.targetPath.slice(0, 200) : null,
    nearbyText: typeof ctx.nearbyText === 'string' ? ctx.nearbyText.slice(0, 120) : null,
    targetRect: sanitizeRect(ctx.targetRect),
    markerViewportPoint: sanitizePoint(ctx.markerViewportPoint),
    viewportSize:
      ctx.viewportSize &&
      Number.isFinite(ctx.viewportSize.width) &&
      Number.isFinite(ctx.viewportSize.height)
        ? {
            width: Math.round(ctx.viewportSize.width),
            height: Math.round(ctx.viewportSize.height),
          }
        : undefined,
    themeVariant: ctx.themeVariant === 'dark' ? 'dark' : ctx.themeVariant === 'light' ? 'light' : undefined,
    componentContext:
      comp && typeof comp === 'object'
        ? {
            framework: ['react', 'vue', 'svelte'].includes(comp.framework) ? comp.framework : 'unknown',
            componentName: cleanPageText(comp.componentName, 120),
            filePath: cleanPageText(comp.filePath, 300),
            lineNumber: Number.isSafeInteger(comp.lineNumber) ? comp.lineNumber : undefined,
            columnNumber: Number.isSafeInteger(comp.columnNumber) ? comp.columnNumber : undefined,
            componentStack: Array.isArray(comp.componentStack)
              ? comp.componentStack.map((c) => cleanPageText(c, 120) ?? '').slice(0, 6)
              : undefined,
          }
        : undefined,
  };
}

/**
 * @param {any} ax
 * @returns {AXContext}
 */
function sanitizeAXContext(ax) {
  return {
    appName: typeof ax.appName === 'string' ? ax.appName : 'Unknown App',
    bundleIdentifier: typeof ax.bundleIdentifier === 'string' ? ax.bundleIdentifier : 'unknown.bundle.id',
    windowTitle: typeof ax.windowTitle === 'string' ? ax.windowTitle : undefined,
    role: typeof ax.role === 'string' ? ax.role : undefined,
    subrole: typeof ax.subrole === 'string' ? ax.subrole : undefined,
    title: typeof ax.title === 'string' ? ax.title.slice(0, 120) : undefined,
    description: typeof ax.description === 'string' ? ax.description.slice(0, 120) : undefined,
    identifier: typeof ax.identifier === 'string' ? ax.identifier : undefined,
    value: typeof ax.value === 'string' ? ax.value.slice(0, 120) : undefined,
    bounds: sanitizeRect(ax.bounds),
    axTree: typeof ax.axTree === 'string' ? ax.axTree.slice(0, 8000) : undefined,
  };
}

/**
 * Strip control characters / newlines from page-controlled text and cap its length.
 * @param {any} v
 * @param {number} max
 * @returns {string | undefined}
 */
function cleanPageText(v, max) {
  if (typeof v !== 'string') return undefined;
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);
}

function sanitizeRect(r) {
  if (!r || typeof r !== 'object') return undefined;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sanitizePoint(p) {
  if (!p || typeof p !== 'object') return undefined;
  const { x, y } = p;
  if (![x, y].every(Number.isFinite)) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

function sanitizeScreenshot(s) {
  if (!s || typeof s !== 'object') return undefined;
  return {
    dataUrl: typeof s.dataUrl === 'string' && s.dataUrl.startsWith('data:image/') ? s.dataUrl : undefined,
    // localPath is hub-owned: never trust a client-supplied path (prevents arbitrary file reads by agents).
    width: Number.isFinite(s.width) ? Math.round(s.width) : undefined,
    height: Number.isFinite(s.height) ? Math.round(s.height) : undefined,
    cropViewportRect: sanitizeRect(s.cropViewportRect),
  };
}
