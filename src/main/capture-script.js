'use strict';

/**
 * installMirrorCapture()
 *
 * This function is INJECTED into every page/frame of the LEADER browser
 * context (via Playwright addInitScript + a one-off evaluate on the current
 * page). It runs inside the page, so it must be fully self-contained and use
 * only browser globals — no Node references, no closures over outer scope.
 *
 * It listens (in the capture phase) for user actions and forwards a compact,
 * SEMANTIC description of each one to the controller through the Playwright
 * binding `window.__mirrorEmit`. The controller then replays them on the
 * follower using trusted input.
 */
function installMirrorCapture() {
  // A popup's initial about:blank Window can inherit properties from its
  // opener even though it does not inherit the opener's event listeners.
  // Guard on the document itself so every new document gets a real listener
  // installation instead of trusting an inherited window flag.
  if (document.__mirrorCaptureInstalled) return;
  try {
    Object.defineProperty(document, '__mirrorCaptureInstalled', {
      value: true,
      configurable: false,
    });
  } catch (_) {
    document.__mirrorCaptureInstalled = true;
  }
  window.__mirrorCaptureInstalled = true;

  function isBlockedHelperFrame() {
    try {
      if (window.top === window) return false;
      var host = String(location.hostname || '').toLowerCase();
      var pathname = String(location.pathname || '').toLowerCase();
      return pathname === '/static/proxy.html'
        && (
          host === 'feedback-pa.clients6.google.com'
          || host === 'clients6.google.com'
          || host.slice(-20) === '.clients6.google.com'
        );
    } catch (_) {
      return false;
    }
  }

  var emit = function (payload) {
    try {
      // Google embeds gapi transport helpers such as
      // feedback-pa.clients6.google.com/static/proxy.html in hidden frames.
      // They are plumbing, not user-facing documents, and replaying their
      // synthetic actions as trusted input can open the helper as a real tab.
      if (isBlockedHelperFrame()) return;
      if (typeof window.__mirrorEmit === 'function') {
        window.__mirrorEmit(JSON.stringify(payload));
      }
    } catch (_) {
      /* binding not ready / detached frame — ignore */
    }
  };

  function emitNav() {
    // The capture script runs in every frame so iframe clicks and inputs can
    // still be mirrored inside their matching follower frame. A frame's own
    // History API changes, however, must never become a top-level follower
    // navigation (for example Google's feedback proxy iframe).
    try {
      if (window.top !== window) return;
    } catch (_) {
      return;
    }
    emit({ kind: 'nav', href: location.href, ts: Date.now() });
  }

  var tabActivationScheduled = false;
  function emitTabActivation() {
    try {
      if (window.top !== window || document.visibilityState !== 'visible') return;
    } catch (_) {
      return;
    }
    if (tabActivationScheduled) return;
    tabActivationScheduled = true;
    setTimeout(function () {
      tabActivationScheduled = false;
      try {
        if (document.visibilityState !== 'visible') return;
      } catch (_) {
        return;
      }
      emit({ kind: 'tab-activate', ts: Date.now() });
    }, 0);
  }

  function isSensitiveChallenge(el) {
    try {
      var href = String(location.href || '').toLowerCase();
      if (
        href.indexOf('challenges.cloudflare.com') !== -1 ||
        href.indexOf('captcha') !== -1 ||
        href.indexOf('turnstile') !== -1 ||
        href.indexOf('/cdn-cgi/challenge-platform/') !== -1
      ) {
        return true;
      }
      var node = el;
      while (node && node.nodeType === 1) {
        var hay = [
          node.id,
          node.className,
          node.getAttribute && node.getAttribute('name'),
          node.getAttribute && node.getAttribute('title'),
          node.getAttribute && node.getAttribute('aria-label'),
          node.getAttribute && node.getAttribute('src'),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (
          hay.indexOf('captcha') !== -1 ||
          hay.indexOf('turnstile') !== -1 ||
          hay.indexOf('cf-challenge') !== -1 ||
          hay.indexOf('cloudflare') !== -1 ||
          hay.indexOf('challenges.cloudflare.com') !== -1
        ) {
          return true;
        }
        node = node.parentElement;
      }
    } catch (_) {}
    return false;
  }

  var cssEsc =
    window.CSS && CSS.escape
      ? CSS.escape
      : function (s) {
          return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
            return '\\' + c;
          });
        };

  function quoteAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  }

  // Try to find a short, stable, unique selector via id / data-* / name / aria.
  function attrSelector(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && isUnique('#' + cssEsc(el.id))) return '#' + cssEsc(el.id);
    var attrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name', 'aria-label', 'placeholder', 'title', 'alt'];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      var v = el.getAttribute && el.getAttribute(a);
      if (v) {
        var sel = tag + '[' + a + '="' + quoteAttr(v) + '"]';
        if (isUnique(sel)) return sel;
      }
    }
    return null;
  }

  // Fallback: a structural path using :nth-of-type, anchored at the nearest
  // ancestor that has a unique id (keeps selectors short and resilient).
  function nthPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      if (node.id && isUnique('#' + cssEsc(node.id))) {
        parts.unshift('#' + cssEsc(node.id));
        break;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function textSelector(el) {
    try {
      var tag = el.tagName.toLowerCase();
      var text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length > 60) return null;
      var candidates = Array.prototype.filter.call(document.querySelectorAll(tag), function (n) {
        return (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ') === text;
      });
      if (candidates.length === 1) return tag + ':text("' + quoteAttr(text) + '")';
    } catch (_) {}
    return null;
  }

  function selectorsFor(el) {
    var list = [];
    var a = attrSelector(el);
    if (a) list.push(a);
    var p = nthPath(el);
    if (p && list.indexOf(p) === -1) list.push(p);
    var tag = el && el.tagName ? el.tagName.toLowerCase() : '';
    var canUseText = !el.isContentEditable && tag !== 'input' && tag !== 'textarea' && tag !== 'select';
    var t = canUseText ? textSelector(el) : null;
    if (t && list.indexOf(t) === -1) list.push(t);
    return list;
  }

  function eventTarget(ev) {
    try {
      if (ev.composedPath) {
        var path = ev.composedPath();
        for (var i = 0; i < path.length; i++) {
          if (path[i] && path[i].nodeType === 1) return path[i];
        }
      }
    } catch (_) {}
    return ev.target;
  }

  function scrollTarget() {
    var el = document.scrollingElement || document.documentElement || document.body;
    if (!el) return { x: window.scrollX, y: window.scrollY, selectors: [] };
    return {
      x: el.scrollLeft || window.scrollX || 0,
      y: el.scrollTop || window.scrollY || 0,
      selectors: selectorsFor(el),
    };
  }

  function textValue(el) {
    if (!el || el.nodeType !== 1) return '';
    return el.isContentEditable ? el.innerText || '' : el.value != null ? el.value : '';
  }

  function textSelection(el) {
    try {
      if (el.isContentEditable) return null;
      if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
        return {
          start: el.selectionStart,
          end: el.selectionEnd,
          direction: el.selectionDirection || 'none',
        };
      }
    } catch (_) {}
    return null;
  }

  function submitTarget(el) {
    try {
      var node = el;
      while (node && node.nodeType === 1) {
        var tag = node.tagName.toLowerCase();
        var type = (node.getAttribute && node.getAttribute('type') || '').toLowerCase();
        if (tag === 'button') return type === '' || type === 'submit';
        if (tag === 'input') return type === 'submit' || type === 'image';
        node = node.parentElement;
      }
    } catch (_) {}
    return false;
  }

  // Viewport-relative fraction of the click point, for coordinate fallback
  // when the follower's DOM doesn't contain a matching element.
  function fracFor(el, ev) {
    try {
      var w = window.innerWidth || 1;
      var h = window.innerHeight || 1;
      if (ev && typeof ev.clientX === 'number') {
        return { x: ev.clientX / w, y: ev.clientY / h };
      }
      var r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2) / w, y: (r.top + r.height / 2) / h };
    } catch (_) {
      return null;
    }
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return {};
    var text = '';
    try {
      text = (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    } catch (_) {}
    var navigationIntent = false;
    try {
      var node = el;
      while (node && node.nodeType === 1) {
        var nodeTag = String(node.tagName || '').toLowerCase();
        if (nodeTag === 'a' || nodeTag === 'area' || nodeTag === 'form') {
          navigationIntent = true;
          break;
        }
        node = node.parentElement;
      }
    } catch (_) {}
    return {
      selectors: selectorsFor(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute ? el.getAttribute('type') : null,
      text: text,
      navigationIntent: navigationIntent,
    };
  }

  // ---- click (covers buttons, links, checkboxes via label, etc.) ----
  document.addEventListener(
    'click',
    function (ev) {
      if (!ev.isTrusted) return;
      var el = eventTarget(ev);
      if (!el || el.nodeType !== 1) return;
      if (isSensitiveChallenge(el)) return;
      var d = describe(el);
      d.kind = 'click';
      d.isSubmit = submitTarget(el);
      d.frac = fracFor(el, ev);
      d.ts = Date.now();
      emit(d);
    },
    true
  );

  // ---- input (covers typing, paste, drag-drop text, and autofill) ----
  // Only text-enterable fields. <select>, checkbox, radio, etc. also fire
  // 'input', but they are handled by the 'change' listener below.
  var NON_TEXT = {
    checkbox: 1, radio: 1, button: 1, submit: 1, reset: 1,
    file: 1, range: 1, color: 1, image: 1,
  };
  var lastTextValues = new WeakMap();
  var pendingTextOps = [];
  document.addEventListener(
    'focusin',
    function (ev) {
      if (!ev.isTrusted) return;
      var el = eventTarget(ev);
      if (el && el.nodeType === 1) lastTextValues.set(el, textValue(el));
    },
    true
  );
  document.addEventListener(
    'beforeinput',
    function (ev) {
      if (!ev.isTrusted) return;
      var el = eventTarget(ev);
      if (!el || el.nodeType !== 1) return;
      if (isSensitiveChallenge(el)) return;
      var isCE = !!el.isContentEditable;
      if (!isCE) {
        var tag0 = el.tagName.toLowerCase();
        if (tag0 === 'select') return;
        if (tag0 !== 'textarea' && NON_TEXT[el.type]) return;
      }
      var before = textValue(el);
      lastTextValues.set(el, before);
      pendingTextOps.push({
        target: el,
        inputType: ev.inputType || '',
        data: ev.data == null ? null : String(ev.data),
        valueBefore: before,
        selectionBefore: textSelection(el),
        ts: Date.now(),
      });
      if (pendingTextOps.length > 20) pendingTextOps.shift();
    },
    true
  );
  document.addEventListener(
    'input',
    function (ev) {
      if (!ev.isTrusted) return;
      var el = eventTarget(ev);
      if (!el || el.nodeType !== 1) return;
      if (isSensitiveChallenge(el)) return;
      var isCE = !!el.isContentEditable;
      if (!isCE) {
        var tag0 = el.tagName.toLowerCase();
        if (tag0 === 'select') return;
        if (tag0 !== 'textarea' && NON_TEXT[el.type]) return;
      }
      var d = describe(el);
      d.kind = 'input';
      d.contentEditable = isCE;
      d.isPassword = el.type === 'password';
      d.value = textValue(el);
      d.selection = textSelection(el);
      d.valueBefore = lastTextValues.has(el) ? lastTextValues.get(el) : null;
      for (var i = pendingTextOps.length - 1; i >= 0; i--) {
        var op = pendingTextOps[i];
        if (op.target === el) {
          pendingTextOps.splice(i, 1);
          d.kind = 'text-op';
          d.inputType = op.inputType;
          d.data = op.data;
          d.valueBefore = op.valueBefore;
          d.selectionBefore = op.selectionBefore;
          break;
        }
      }
      if (d.kind === 'input' && d.valueBefore != null) {
        d.kind = 'text-op';
        d.inputType = ev.inputType || 'insertReplacementText';
        d.data = ev.data == null ? null : String(ev.data);
      }
      lastTextValues.set(el, d.value);
      d.ts = Date.now();
      emit(d);
    },
    true
  );

  // ---- change (select dropdowns, checkboxes, radios) ----
  document.addEventListener(
    'change',
    function (ev) {
      if (!ev.isTrusted) return;
      var el = eventTarget(ev);
      if (!el || el.nodeType !== 1) return;
      var tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        var d = describe(el);
        d.kind = 'select';
        d.value = el.value;
        d.ts = Date.now();
        emit(d);
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        var c = describe(el);
        c.kind = 'check';
        c.checked = !!el.checked;
        c.value = el.value;
        c.ts = Date.now();
        emit(c);
      }
    },
    true
  );

  // ---- keydown: forward only navigation/command keys + shortcuts ----
  // (Plain character keys are already covered by the 'input' handler above,
  //  so forwarding them here too would double-type.)
  var SPECIAL = {
    Enter: 1, Tab: 1, Escape: 1, Backspace: 1, Delete: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1,
  };
  var LONE_MOD = { Control: 1, Shift: 1, Alt: 1, Meta: 1 };
  document.addEventListener(
    'keydown',
    function (ev) {
      if (!ev.isTrusted) return;
      if (LONE_MOD[ev.key]) return;
      var hasMod = ev.ctrlKey || ev.metaKey || ev.altKey;
      if (!SPECIAL[ev.key] && !hasMod) return;
      var target = eventTarget(ev);
      if (isSensitiveChallenge(target)) return;
      var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      var isEditable = !!(target && (target.isContentEditable || tag === 'input' || tag === 'textarea'));
      if (isEditable && hasMod && String(ev.key).toLowerCase() === 'v') return;
      if (isEditable && !hasMod && (ev.key === 'Backspace' || ev.key === 'Delete')) return;
      var d = describe(target);
      d.kind = 'key';
      d.key = ev.key;
      d.ctrl = ev.ctrlKey;
      d.meta = ev.metaKey;
      d.alt = ev.altKey;
      d.shift = ev.shiftKey;
      d.ts = Date.now();
      emit(d);
    },
    true
  );

  // ---- scroll (throttled, window-level) ----
  var scrollScheduled = false;
  window.addEventListener(
    'scroll',
    function (ev) {
      if (!ev.isTrusted) return;
      if (scrollScheduled) return;
      scrollScheduled = true;
      setTimeout(function () {
        scrollScheduled = false;
        var s = scrollTarget();
        s.kind = 'scroll';
        s.ts = Date.now();
        emit(s);
      // Absolute scroll positions are coalesced by the engine, so a two-frame
      // cadence stays accurate while feeling substantially more immediate.
      }, 32);
    },
    true
  );

  // Chrome tab switches do not create a DOM click inside the page. Treat the
  // newly visible top-level document as the authoritative active-tab signal
  // so its paired follower tab is foregrounded immediately.
  document.addEventListener('visibilitychange', emitTabActivation, true);
  window.addEventListener('focus', emitTabActivation, true);
  setTimeout(emitTabActivation, 0);

  // ---- SPA navigation ----
  try {
    var pushState = history.pushState;
    var replaceState = history.replaceState;
    history.pushState = function () {
      var r = pushState.apply(this, arguments);
      setTimeout(emitNav, 0);
      return r;
    };
    history.replaceState = function () {
      var r = replaceState.apply(this, arguments);
      setTimeout(emitNav, 0);
      return r;
    };
    window.addEventListener('popstate', emitNav, true);
    window.addEventListener('hashchange', emitNav, true);
  } catch (_) {}
}

module.exports = installMirrorCapture;
