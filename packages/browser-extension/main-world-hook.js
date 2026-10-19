/**
 * @fileoverview Main-world probe injected on-demand via `chrome.scripting.executeScript({ world: "MAIN" })`.
 * Extracts React Fiber, Vue 3, or Svelte component names and source locations (`filePath:lineNumber`)
 * when the isolated annotator content script dispatches `__agent_annotator_probe__`.
 */

(function installMainWorldComponentProbe() {
  if (window.__AGENT_ANNOTATOR_MAIN_HOOK_INSTALLED__) return;
  window.__AGENT_ANNOTATOR_MAIN_HOOK_INSTALLED__ = true;

  const ATTR_NAME = 'data-agent-annotator-probe-result';

  /**
   * Inspect React Fiber attached to a DOM node.
   * @param {Element} el
   */
  function inspectReact(el) {
    let curr = el;
    while (curr) {
      const key = Object.keys(curr).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (key) {
        let fiber = curr[key];
        const stack = [];
        let primaryName = null;
        let meaningfulName = null;
        let debugSource = null;
        let steps = 0;

        while (fiber && stack.length < 6 && steps < 25) {
          steps += 1;
          const type = fiber.type;
          let name = null;
          if (typeof type === 'function') {
            name = type.displayName || type.name || null;
          } else if (type && typeof type === 'object') {
            name =
              type.displayName ||
              type.render?.displayName ||
              type.render?.name ||
              type.type?.displayName ||
              type.type?.name ||
              null;
          }
          if (name && !/^(Fragment|Suspense|Context|Provider|Consumer)$/.test(name)) {
            if (!primaryName) primaryName = name;
            if (!meaningfulName && name.length > 2) meaningfulName = name;
            if (stack[stack.length - 1] !== name) stack.push(name);
          }
          if (!debugSource && fiber._debugSource) {
            debugSource = fiber._debugSource;
          }
          if (!debugSource && fiber._debugOwner?._debugSource) {
            debugSource = fiber._debugOwner._debugSource;
          }
          fiber = fiber.return;
        }

        const chosenName = meaningfulName || primaryName;
        if (chosenName || debugSource) {
          return {
            framework: 'react',
            componentName: chosenName || undefined,
            filePath: debugSource?.fileName || undefined,
            lineNumber: debugSource?.lineNumber || undefined,
            columnNumber: debugSource?.columnNumber || undefined,
            componentStack: stack.length > 0 ? stack.reverse() : undefined,
          };
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  /**
   * Inspect Vue 3 component instance attached to a DOM node.
   * @param {Element} el
   */
  function inspectVue(el) {
    let curr = el;
    while (curr) {
      const vnode = curr.__vueParentComponent || curr.__vnode?.component;
      if (vnode) {
        const stack = [];
        let comp = vnode;
        let primaryName = null;
        let filePath = null;

        while (comp && stack.length < 6) {
          const name = comp.type?.__name || comp.type?.name || null;
          if (name) {
            if (!primaryName) primaryName = name;
            if (stack[stack.length - 1] !== name) stack.push(name);
          }
          if (!filePath && comp.type?.__file) {
            filePath = comp.type.__file;
          }
          comp = comp.parent;
        }

        if (primaryName || filePath) {
          return {
            framework: 'vue',
            componentName: primaryName || undefined,
            filePath: filePath || undefined,
            componentStack: stack.length > 0 ? stack.reverse() : undefined,
          };
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  /**
   * Inspect Svelte metadata attached to a DOM node in dev mode.
   * @param {Element} el
   */
  function inspectSvelte(el) {
    let curr = el;
    while (curr) {
      if (curr.__svelte_meta?.loc) {
        const loc = curr.__svelte_meta.loc;
        return {
          framework: 'svelte',
          filePath: loc.file || undefined,
          lineNumber: typeof loc.line === 'number' ? loc.line + 1 : undefined,
          columnNumber: typeof loc.column === 'number' ? loc.column + 1 : undefined,
        };
      }
      curr = curr.parentElement;
    }
    return null;
  }

  document.addEventListener(
    '__agent_annotator_probe__',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      try {
        const info = inspectReact(target) || inspectVue(target) || inspectSvelte(target);
        if (info) {
          target.setAttribute(ATTR_NAME, JSON.stringify(info));
        }
      } catch {
        // Ignore probe errors
      }
    },
    true
  );
})();
