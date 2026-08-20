// src/auto-login.js
//
// Browser-side auto-login. Runs in the page main world (injected by the
// preload) on every genspark.ai navigation. If the partition is already
// logged in, none of the target elements exist and it is a no-op. Otherwise
// it either clicks the sign-in entry (landing page) or fills the Azure AD B2C
// form on login.genspark.ai and submits. While any of that is in flight, an
// opaque branded loading overlay covers the whole page so the user never
// sees the login form / modal / B2C page flash by; it is removed once the
// app reports itself logged in and rendered (or a safety timeout fires).
//
// The overlay/reveal logic is a small state machine (see tick()) rather than
// a single "logged in" boolean check: on a typical SPA the initial #root
// shell has document.readyState !== 'loading' and body.children.length > 0
// long before the app actually mounts and its auth check resolves, so a
// naive "page looks rendered => reveal" test fires immediately, removes the
// overlay, disconnects the observer, and permanently aborts auto-login for
// that page load. The machine instead distinguishes "submitted credentials,
// waiting for the app to come up" from "never needed to log in, but must
// wait for render + a quiet/settle period + a minimum dwell before
// concluding it's actually logged in" so an empty shell alone can't trigger
// a premature reveal.
//
// NOTE: selectors are DOM-verified against the live genspark.ai login flow
// (landing-page modal trigger + "更多选项" step, then the login.genspark.ai
// Azure B2C form). See loginContentMain for the details captured from
// observation.
function loginContentMain(email, password) {
  var DONE = '__gsAutoLoginFilled'
  var OPENED = '__gsAutoLoginOpened'
  var MORE = '__gsAutoLoginMore'
  var OVERLAY_ID = 'gs-auto-login-overlay'
  var K_SUBMITTED = '__gsAutoLoginSubmitted'
  var K_LOGGEDIN = '__gsAutoLoginLoggedIn'
  var LOGIN_RE = /^(登\s*录|sign\s?in|log\s?in)$/i
  var REVEAL_AFTER_MS = 20000
  var SETTLE_MS = 1200
  var MIN_DWELL_MS = 1500
  var startedAt = Date.now()
  var lastMut = startedAt
  var obs
  var poll

  function q(sel) { return document.querySelector(sel) }

  function vis(el) {
    if (!el) return false
    var r = el.getBoundingClientRect()
    var s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }

  function setValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // The sign-in entry and "more options" are styled <div>/<span>, not links or
  // buttons, so the search cannot be limited to a,button.
  function leafByText(re, click) {
    var els = document.querySelectorAll('a,button,div,span')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.children.length) continue
      if (!re.test((el.textContent || '').trim())) continue
      if (!vis(el)) continue
      if (click) (el.closest('button') || el.closest('a') || el).click()
      return true
    }
    return false
  }
  function clickByText(re) { return leafByText(re, true) }
  function hasText(re) { return leafByText(re, false) }

  function ss(k) { try { return sessionStorage.getItem(k) } catch (e) { return null } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v) } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k) } catch (e) {} }

  function ensureAttached() {
    var el = document.getElementById(OVERLAY_ID)
    if (el && document.body && el.parentNode !== document.body) document.body.appendChild(el)
  }
  function showOverlay() {
    if (document.getElementById(OVERLAY_ID)) { ensureAttached(); return }
    var el = document.createElement('div')
    el.id = OVERLAY_ID
    // visibility:visible !important keeps the overlay showing even while the
    // preload's anti-flicker rule holds :root hidden.
    el.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:18px', 'margin:0', 'background:#1a1b1c', 'visibility:visible !important', 'opacity:1'
    ].join(';'))
    el.innerHTML =
      '<div style="width:44px;height:44px;border:3px solid #3a3b3c;border-top-color:#e6e6e6;' +
        'border-radius:50%;animation:gsspin 0.8s linear infinite"></div>' +
      '<div style="color:#e6e6e6;font-size:16px;letter-spacing:2px;' +
        'font-family:-apple-system,system-ui,sans-serif">老猫 · 正在登录…</div>' +
      '<style>@keyframes gsspin{to{transform:rotate(360deg)}}' +
        '#' + OVERLAY_ID + '{visibility:visible !important}</style>'
    ;(document.body || document.documentElement).appendChild(el)
  }
  function hideOverlay() {
    var el = document.getElementById(OVERLAY_ID)
    if (el) el.remove()
  }

  function finish(loggedIn) {
    hideOverlay()
    ssDel(K_SUBMITTED)
    if (loggedIn) ssSet(K_LOGGEDIN, '1')
    if (obs) obs.disconnect()
    if (poll) clearInterval(poll)
  }

  function ready() {
    return document.readyState === 'complete' && !!document.body && document.body.children.length > 0
  }

  function b2cError() {
    var e = q('.error.itemLevel[aria-hidden="false"]') || q('#claimVerificationServerError') || q('.error.pageLevel')
    return !!(e && vis(e) && (e.textContent || '').trim().length > 0)
  }

  function fillB2C() {
    var emailEl = q('#email') || q('input[type=email]') || q('#signInName')
    var passEl = q('#password') || q('input[type=password]')
    if (!emailEl || !passEl) return false
    if (!vis(emailEl)) {
      var toggle = q('#loginWithEmailWrapper')
      if (toggle) { toggle.click(); return false }
    }
    setValue(emailEl, email)
    setValue(passEl, password)
    // #next is the real "Sign in"; the first button[type=submit] is the
    // unrelated "Login with email", so it is the last resort only.
    var submit = q('#next') || q('#continue') || q('#submit') ||
      q('#localAccountForm button[type=submit]') || q('button[type=submit]')
    if (submit) submit.click()
    return true
  }

  function enterLogin() {
    if (!window[MORE] && clickByText(/^(更多选项|more options)$/i)) {
      window[MORE] = true
      return
    }
    if (window[OPENED]) return
    if (clickByText(LOGIN_RE)) window[OPENED] = true
  }

  function tick() {
    var now = Date.now()
    if (now - startedAt > REVEAL_AFTER_MS) { finish(false); return }

    if (location.hostname === 'login.genspark.ai') {
      if (b2cError()) { finish(false); return }   // surface the error so the user can act
      showOverlay()
      if (!window[DONE] && fillB2C()) { window[DONE] = true; ssSet(K_SUBMITTED, '1') }
      return
    }

    if (location.hostname.endsWith('genspark.ai')) {
      // Known logged-in this session: never cover, just reveal.
      if (ss(K_LOGGEDIN) === '1' && !hasText(LOGIN_RE)) { finish(false); return }

      // A sign-in trigger is present → we are logged out; run the flow covered.
      if (hasText(LOGIN_RE)) { ssDel(K_LOGGEDIN); showOverlay(); enterLogin(); return }

      // No sign-in trigger visible (yet).
      var submitted = ss(K_SUBMITTED) === '1'
      if (submitted && ready()) { ssDel(K_SUBMITTED); finish(true); return }   // returned logged-in

      // Never needed login: only conclude "already logged in" after the page has
      // rendered AND gone quiet AND a minimum dwell — an empty SPA shell alone
      // must not trigger a reveal.
      if (!submitted && ready() && (now - startedAt > MIN_DWELL_MS) && (now - lastMut > SETTLE_MS)) {
        finish(true); return
      }

      // Otherwise keep waiting under the overlay.
      showOverlay()
    }
  }

  obs = new MutationObserver(function () { lastMut = Date.now(); tick() })
  obs.observe(document.documentElement, { childList: true, subtree: true })
  tick()
  // Poll so the settle / dwell / timeout conditions still fire when no mutations occur.
  poll = setInterval(tick, 400)
  setTimeout(function () { finish(false) }, REVEAL_AFTER_MS)
}

function buildLoginScript(email, password) {
  return '(' + loginContentMain.toString() + ')(' +
    JSON.stringify(email) + ',' + JSON.stringify(password) + ');'
}

module.exports = { loginContentMain, buildLoginScript }
