import { CFG } from './enhance_shared.js';
import { SEL } from './host_probe.js';

// ============================================================
// Footer button label abbreviation.
// ============================================================
// Host renders the permission-mode button label in full ("Bypass
// permissions", "Ask before edits", ...). At our 13px footer width those
// wrap or get clipped by the host's own truncation. Strip them down to
// the first word ("Bypass", "Ask", ...) — the parent button keeps the
// full sentence in its `title` attribute, so hover still discloses the
// mode description.
//
// Why scope to the footer instead of `document.body`: a `characterData`
// observer on body subtree disables Chromium's IME paint optimization
// and re-introduces the phantom-glyph bug (see "IME paint 残留 bug" in
// memo). The footer is a sibling of `inputContainer`, never an ancestor
// of the editor, so its observer cannot reach the contenteditable node.
function setupFooterAbbreviation() {
  let footerObs = null;
  let attachedFooter = null;

  function firstWord(text) {
    const m = (text || '').trim().match(/^\S+/);
    return m ? m[0] : '';
  }

  // Idempotent: stores the original full text on the span itself, so a
  // repeat scan against an already-abbreviated label is a no-op. When
  // React swaps in a different mode label, current text no longer
  // matches `firstWord(stored)` and we re-derive.
  function abbreviate(span) {
    if (!span || span.nodeType !== 1) return;
    const cur = span.textContent;
    if (!cur) return;
    const stored = span.dataset.incipitFooterFull;
    if (stored && cur === firstWord(stored)) return;
    const first = firstWord(cur);
    if (!first) return;
    span.dataset.incipitFooterFull = cur;
    if (cur !== first) span.textContent = first;
  }

  function scanAll(root) {
    if (!root || !root.querySelectorAll) return;
    const SEL = '[data-incipit-footer-button-label]';
    if (root.matches?.(SEL)) abbreviate(root);
    root.querySelectorAll(SEL).forEach(abbreviate);
  }

  function attach(footer) {
    if (!footer || footer === attachedFooter) return;
    if (footerObs) footerObs.disconnect();
    attachedFooter = footer;
    scanAll(footer);
    footerObs = new MutationObserver(() => scanAll(footer));
    footerObs.observe(footer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  const initial = document.querySelector('[data-incipit-input-footer]');
  if (initial) attach(initial);

  // Body-level finder is childList-only (no characterData) and so safe
  // against the IME paint bug. Its only job is to spot footer remounts.
  const finder = new MutationObserver(() => {
    const f = document.querySelector('[data-incipit-input-footer]');
    if (f && f !== attachedFooter) attach(f);
  });
  finder.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Inline keyboard symbols → SVG.
// ============================================================
// The host renders shortcut hints like `⇧ + tab to switch` using
// `<kbd>` chips that contain Unicode modifier glyphs (U+21E7, etc.).
// Cross-platform font fallback for these glyphs is unreliable: Segoe
// UI Symbol on Windows draws a thin stroke arrow that visually
// disagrees with the next-door letter `tab` (Rec Mono Linear, solid
// glyph weight). Replace the character with an inline SVG drawn at
// the same visual weight as a Latin uppercase letter so left and
// right chips read as siblings on every OS.
//
// The map is character-keyed and trivially extensible — add a new
// entry to cover ⌘ ⌥ ⌃ ⏎ ⌫ ⎋ if the host starts shipping them.
function setupKbdSymbols() {
  const SVG_MAP = {
    // ⇧ Shift (U+21E7). viewBox 12×12 matches uppercase letter
    // cap-height proportions; solid fill on currentColor so the
    // chip foreground tints both letter and arrow uniformly.
    '⇧':
      '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"' +
      ' style="display:inline-block;width:0.85em;height:0.85em;' +
      'vertical-align:-0.13em;fill:currentColor">' +
      '<path d="M6 1 L10.5 6 L8 6 L8 11 L4 11 L4 6 L1.5 6 Z"/>' +
      '</svg>',
  };

  const SEL = '[class*="menuHeaderHint"] kbd, [class*="keys_"] kbd';

  function decorate(kbd) {
    if (!kbd || kbd.nodeType !== 1) return;
    if (kbd.dataset.incipitKbdSvg === '1') return;
    const txt = (kbd.textContent || '').trim();
    if (txt.length !== 1) return;
    const svg = SVG_MAP[txt];
    if (!svg) return;
    kbd.dataset.incipitKbdSvg = '1';
    kbd.innerHTML = svg;
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches?.(SEL)) decorate(root);
    root.querySelectorAll(SEL).forEach(decorate);
  }

  scan(document.body);

  // Body-level childList observer (no characterData → IME-paint safe).
  // Modes/history popups mount on demand, so we cannot just attach
  // once at init.
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scan(n);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Cache badge.
// ============================================================
// Data arrives from the extension host through `webview.postMessage`.
// The badge is inserted into the input footer before the bypass control.
function setupCacheBadge() {
  if (!CFG.sessionUsage) return;
  var BADGE_CLASS = 'cceBadge';
  var TEXT_CLASS = 'cceBadgeText';
  var POPUP_CLASS = 'cceStatPopup';
  // Outline icon with descending bars for a lightweight stats metaphor.
  var ICON_SVG = '<svg class="cceBadgeIcon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="4" y1="6" x2="16" y2="6"/>' +
    '<line x1="4" y1="10" x2="13" y2="10"/>' +
    '<line x1="4" y1="14" x2="9" y2="14"/>' +
    '</svg>';
  var latest = null;       // Latest payload: ctx/hit plus recent and totals.
  var popupEl = null;
  var popupAnchor = null;  // Badge button currently anchoring the popup.

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) {
      var k = n / 1000;
      return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }
    return String(n);
  }
  function fmtPct(p) {
    if (!Number.isFinite(p) || p < 0) return '—';
    return (p * 100).toFixed(2) + '%';
  }
  function fmtRelTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (isNaN(t)) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' h ' + (mm ? mm + ' min' : '');
  }
  function revealVal(el, target) {
    if (el.__cceRAF) { cancelAnimationFrame(el.__cceRAF); el.__cceRAF = null; }
    if (!target) { el.textContent = ''; return; }
    var len = target.length;
    var display = new Array(len + 1).join(' ');
    // Frame-counted instead of timestamp-based: STEP=40ms vs rAF's 16.67ms
    // gave a 2-2-3-2-3 cadence that read as jitter. N frames per step keeps
    // every advance landing on a vsync edge — clean rhythm at any refresh
    // rate, slightly faster on 120Hz panels (acceptable trade for stability).
    var FRAMES_PER_STEP = 16;
    var index = 0, frameSkip = 0;
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function frame() {
      if (frameSkip < FRAMES_PER_STEP - 1) {
        frameSkip++;
        el.__cceRAF = requestAnimationFrame(frame);
        return;
      }
      frameSkip = 0;
      if (index - 3 >= len) {
        el.textContent = target;
        el.__cceRAF = null;
        return;
      }
      var arr = display.split('');
      for (var w = 0; w <= 3; w++) {
        var F = index - w;
        if (F >= 0 && F < len) {
          var ch = target[F];
          if (ch === ' ') arr[F] = ' ';
          else if (w === 3) arr[F] = ch;
          else if (w === 0) arr[F] = '\u258C';
          else arr[F] = pick(['.', '_', ch]);
        }
      }
      display = arr.join('');
      el.textContent = display;
      index++;
      el.__cceRAF = requestAnimationFrame(frame);
    }
    el.__cceRAF = requestAnimationFrame(frame);
  }
  // Some backends expose no prompt-cache counters at all.
  // Show `—` instead of `0%` so the UI reads as unsupported, not as a miss.
  function sessionHasNoCache(payload) {
    if (!payload || !payload.totals) return false;
    var T = payload.totals;
    return (T.cr || 0) === 0 && (T.cw || 0) === 0;
  }
  function renderText(textEl) {
    if (!textEl) return;
    var ctxStr, hitStr;
    if (!latest) {
      ctxStr = '—'; hitStr = '—';
    } else {
      ctxStr = fmtTokens(latest.ctx);
      hitStr = sessionHasNoCache(latest) ? '—' : fmtPct(latest.hit);
    }
    if (!textEl.__cceBuilt) {
      textEl.innerHTML =
        '<span class="cceBadgeLabel">Ctx</span> ' +
        '<span class="cceBadgeVal" data-cce-val="ctx"></span>' +
        '    ' +
        '<span class="cceBadgeLabel">Cache</span> ' +
        '<span class="cceBadgeVal" data-cce-val="hit"></span>';
      textEl.__cceBuilt = true;
    }
    var ctxEl = textEl.querySelector('[data-cce-val="ctx"]');
    var hitEl = textEl.querySelector('[data-cce-val="hit"]');
    if (ctxEl && ctxEl.__cceLast !== ctxStr) {
      var firstCtx = ctxEl.__cceLast === undefined;
      ctxEl.__cceLast = ctxStr;
      if (firstCtx) ctxEl.textContent = ctxStr;
      else revealVal(ctxEl, ctxStr);
    }
    if (hitEl && hitEl.__cceLast !== hitStr) {
      var firstHit = hitEl.__cceLast === undefined;
      hitEl.__cceLast = hitStr;
      if (firstHit) hitEl.textContent = hitStr;
      else revealVal(hitEl, hitStr);
    }
  }

  function buildPopup() {
    var el = document.createElement('div');
    el.className = POPUP_CLASS;
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">Recent requests</div>' +
        '<div class="cceStatRecent" data-recent></div>' +
      '</div>' +
      '<div class="cceStatDivider"></div>' +
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">Session</div>' +
        '<div class="cceStatTotals" data-totals></div>' +
      '</div>';
    el.addEventListener('click', function(ev) { ev.stopPropagation(); });
    return el;
  }
  function renderPopup() {
    if (!popupEl) return;
    var recentBox = popupEl.querySelector('[data-recent]');
    var totalsBox = popupEl.querySelector('[data-totals]');
    if (recentBox) {
      if (!latest || !latest.recent || !latest.recent.length) {
        recentBox.innerHTML = '<div class="cceStatEmpty">No requests yet</div>';
      } else {
        var rows = '';
        for (var i = 0; i < latest.recent.length; i++) {
          var r = latest.recent[i];
          rows +=
            '<div class="cceStatRow">' +
              '<span class="cceStatTime" data-ts="' + (r.ts || '') + '">' + fmtRelTime(r.ts) + '</span>' +
              '<span class="cceStatCtx">' + fmtTokens(r.ctx) + '</span>' +
              '<span class="cceStatHit">' + fmtPct(r.hit) + '</span>' +
            '</div>';
        }
        recentBox.innerHTML = rows;
      }
    }
    if (totalsBox) {
      if (!latest || !latest.totals) {
        totalsBox.innerHTML = '<div class="cceStatEmpty">—</div>';
      } else {
        var T = latest.totals;
        var lines = [
          ['Requests',    String(T.requests || 0),                ''],
          ['Duration',    fmtDuration(T.durationMs || 0),         ''],
          ['Fresh input', fmtTokens(T.fresh || 0),                ''],
          ['Cache write', fmtTokens(T.cw || 0),                   ''],
          ['Cache read',  fmtTokens(T.cr || 0),                   sessionHasNoCache(latest) ? '—' : fmtPct(T.hitOverall || 0)],
          ['Output',      fmtTokens(T.out || 0),                  ''],
        ];
        var html = '';
        for (var j = 0; j < lines.length; j++) {
          var L = lines[j];
          html +=
            '<div class="cceStatKV">' +
              '<span class="cceStatLabel">' + L[0] + '</span>' +
              '<span class="cceStatValue">' + L[1] + '</span>' +
              '<span class="cceStatExtra">' + L[2] + '</span>' +
            '</div>';
        }
        totalsBox.innerHTML = html;
      }
    }
  }
  function positionPopup() {
    if (!popupEl || !popupAnchor) return;
    var r = popupAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var margin = 8;
    // Clamp max-width so a narrow side panel collapses the popup instead
    // of letting it bleed past the viewport right edge.
    popupEl.style.maxWidth = Math.min(400, Math.max(180, vw - margin * 2)) + 'px';
    var w = popupEl.offsetWidth;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    popupEl.style.left = left + 'px';
    popupEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
  }
  // Relative-time labels in the popup ("3s ago" / "2m ago") are the only
  // reason this UI ever needs sub-payload refresh. Keep the work local to
  // the popup lifecycle so the extension host does not re-broadcast on a
  // 1.5s tick just to nudge these spans. We update only `[data-ts]` text,
  // not the whole row, to avoid innerHTML churn.
  var popupTimer = null;
  function refreshRelTimes() {
    if (!popupEl) return;
    var nodes = popupEl.querySelectorAll('[data-ts]');
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('data-ts');
      var next = fmtRelTime(iso);
      if (nodes[i].textContent !== next) nodes[i].textContent = next;
    }
  }
  function startPopupTimer() {
    if (popupTimer) return;
    popupTimer = setInterval(refreshRelTimes, 1000);
  }
  function stopPopupTimer() {
    if (!popupTimer) return;
    clearInterval(popupTimer);
    popupTimer = null;
  }
  function openPopup(anchor) {
    popupAnchor = anchor;
    if (!popupEl) {
      popupEl = buildPopup();
      document.body.appendChild(popupEl);
    }
    popupEl.classList.add('cceStatOpen');
    anchor.classList.add('cceBadgeActive');
    renderPopup();
    positionPopup();
    startPopupTimer();
  }
  function closePopup() {
    if (!popupEl) return;
    popupEl.classList.remove('cceStatOpen');
    if (popupAnchor) popupAnchor.classList.remove('cceBadgeActive');
    popupAnchor = null;
    stopPopupTimer();
  }
  function isOpen() {
    return !!(popupEl && popupEl.classList.contains('cceStatOpen'));
  }

  function ensureBadge() {
    var hosts = document.querySelectorAll(SEL.inputFooterHost);
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (!host) continue;
      var badge = host.querySelector(':scope > .' + BADGE_CLASS);
      if (!badge) {
        badge = document.createElement('button');
        badge.type = 'button';
        badge.className = BADGE_CLASS;
        badge.innerHTML = ICON_SVG + '<span class="' + TEXT_CLASS + '"></span>';
        badge.addEventListener('click', function(ev) {
          ev.stopPropagation();
          if (isOpen() && popupAnchor === ev.currentTarget) {
            closePopup();
          } else {
            openPopup(ev.currentTarget);
          }
        });
        host.insertBefore(badge, host.firstChild);
      }
      var textEl = badge.querySelector('.' + TEXT_CLASS);
      renderText(textEl);
    }
  }

  window.addEventListener('message', function(ev) {
    var d = ev && ev.data;
    if (!d || d.__cceBadge !== true || !d.payload) return;
    latest = d.payload;
    ensureBadge();
    if (isOpen()) { renderPopup(); positionPopup(); }
  });

  document.addEventListener('click', function(ev) {
    if (!isOpen()) return;
    var t = ev.target;
    if (popupEl && popupEl.contains(t)) return;
    if (popupAnchor && popupAnchor.contains(t)) return;
    closePopup();
  }, true);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && isOpen()) closePopup();
  }, true);
  window.addEventListener('resize', function() { if (isOpen()) positionPopup(); });
  window.addEventListener('scroll', function() { if (isOpen()) positionPopup(); }, true);

  // `inputFooter` can remount under React, so keep a small observer to
  // reinsert the badge. The observer is coalesced to at most one
  // `ensureBadge` call per animation frame, and it ignores mutations that
  // cannot possibly touch the footer (no `inputFooter`-class node added).
  var ensureScheduled = false;
  function scheduleEnsureBadge() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(function() { ensureScheduled = false; ensureBadge(); });
  }
  function mutationTouchesFooter(m) {
    for (var i = 0; i < m.addedNodes.length; i++) {
      var n = m.addedNodes[i];
      if (!n || n.nodeType !== 1) continue;
      var cls = typeof n.className === 'string' ? n.className : '';
      if (cls.indexOf('inputFooter') !== -1 || cls.indexOf('Footer') !== -1) return true;
      if (n.querySelector && n.querySelector('[class*="inputFooter"]')) return true;
    }
    return false;
  }
  var mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutationTouchesFooter(mutations[i])) { scheduleEnsureBadge(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  ensureBadge();
}


export function initFooterBadge() {
  setupCacheBadge();
  setupFooterAbbreviation();
  setupKbdSymbols();
}
