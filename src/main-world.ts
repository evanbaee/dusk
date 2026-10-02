/**
 * Runs in the page's own JS world at document_start, and is only registered while
 * Dusk is active. It makes `matchMedia('(prefers-color-scheme: dark)')` report true so
 * sites with a JS-driven theme switch to their own dark mode, and it tells the content
 * script when stylesheets change through the CSSOM (CSS-in-JS, constructed sheets).
 *
 * Messages from the content script arrive as `dusk:force` / `dusk:release` events.
 */
(() => {
  const KEY = Symbol.for('dusk.main');
  const w = window as unknown as Record<symbol, boolean>;
  if (w[KEY]) return;
  w[KEY] = true;

  // Registered scripts run while the page is still loading. If we were injected into a page
  // that was already open, the content script decides later whether to force dark.
  let forced = document.readyState === 'loading';
  window.addEventListener('dusk:ping', () => window.dispatchEvent(new CustomEvent('dusk:pong')));
  const DARK = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
  const LIGHT = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;

  // --- matchMedia -----------------------------------------------------------

  const proto = MediaQueryList.prototype;
  const matchesDesc = Object.getOwnPropertyDescriptor(proto, 'matches');
  const realMatches = matchesDesc?.get;
  const nativeMatchMedia = window.matchMedia;
  const rewritten = new WeakMap<MediaQueryList, MediaQueryList>();
  const lastValue = new WeakMap<MediaQueryList, boolean>();
  const tracked: WeakRef<MediaQueryList>[] = [];

  if (realMatches && nativeMatchMedia) {
    const effective = (mql: MediaQueryList): boolean => {
      const alt = forced ? rewritten.get(mql) : undefined;
      return realMatches.call(alt ?? mql);
    };

    const notify = (mql: MediaQueryList) => {
      const v = effective(mql);
      if (lastValue.get(mql) === v) return;
      lastValue.set(mql, v);
      mql.dispatchEvent(new MediaQueryListEvent('change', { media: mql.media, matches: v }));
    };

    Object.defineProperty(proto, 'matches', {
      ...matchesDesc,
      get(this: MediaQueryList) {
        return effective(this);
      },
    });

    window.matchMedia = function matchMedia(this: Window, query: string): MediaQueryList {
      const mql = nativeMatchMedia.call(this, query);
      const q = String(query);
      if (/prefers-color-scheme/i.test(q) && !rewritten.has(mql)) {
        document.documentElement?.setAttribute('data-dusk-mm', '');
        const alt = nativeMatchMedia.call(this, q.replace(DARK, '(width >= 0px)').replace(LIGHT, '(width < 0px)'));
        rewritten.set(mql, alt);
        lastValue.set(mql, effective(mql));
        tracked.push(new WeakRef(mql));
        // While forced, the real OS preference must not leak through change events.
        mql.addEventListener('change', (e) => {
          if (forced && e.isTrusted) e.stopImmediatePropagation();
        });
        alt.addEventListener('change', () => forced && notify(mql));
      }
      return mql;
    };

    const setForced = (on: boolean) => {
      if (forced === on) return;
      forced = on;
      for (const ref of tracked) {
        const mql = ref.deref();
        if (mql) notify(mql);
      }
    };
    window.addEventListener('dusk:force', () => setForced(true));
    window.addEventListener('dusk:release', () => setForced(false));
  }

  // --- CSSOM change notifications ------------------------------------------

  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      window.dispatchEvent(new CustomEvent('dusk:cssom'));
    });
  };

  const wrap = (target: object | undefined, name: string) => {
    if (!target) return;
    const orig = (target as Record<string, unknown>)[name];
    if (typeof orig !== 'function') return;
    (target as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const result = (orig as (...a: unknown[]) => unknown).apply(this, args);
      changed();
      if (result instanceof Promise) result.then(changed, () => {});
      return result;
    };
  };

  for (const name of ['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replace', 'replaceSync']) {
    wrap(CSSStyleSheet.prototype, name);
  }
  wrap(globalThis.CSSGroupingRule?.prototype, 'insertRule');
  wrap(globalThis.CSSGroupingRule?.prototype, 'deleteRule');

  for (const P of [Document.prototype, ShadowRoot.prototype]) {
    const d = Object.getOwnPropertyDescriptor(P, 'adoptedStyleSheets');
    if (!d?.set) continue;
    Object.defineProperty(P, 'adoptedStyleSheets', {
      ...d,
      set(this: Document | ShadowRoot, v: CSSStyleSheet[]) {
        d.set!.call(this, v);
        changed();
      },
    });
  }

  // Shadow roots attached after an element is already in the DOM (late upgrades).
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('dusk:shadow')));
    return root;
  };
})();
