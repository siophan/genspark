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
// NOTE: selectors are DOM-verified against the live genspark.ai login flow
// (landing-page modal trigger + "更多选项" step, then the login.genspark.ai
// Azure B2C form). See loginContentMain for the details captured from
// observation.
function loginContentMain(email, password) {
  var DONE = '__gsAutoLoginFilled'
  var OPENED = '__gsAutoLoginOpened'
  var MORE = '__gsAutoLoginMore'
  var OVERLAY_ID = 'gs-auto-login-overlay'
  var SPLASH_FLAG = '__gsAutoLoginSplashDone'
  var LOGIN_RE = /^(登\s*录|sign\s?in|log\s?in)$/i
  var REVEAL_AFTER_MS = 20000
  var startedAt = Date.now()
  var obs

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
  // buttons, so the search cannot be limited to a,button. Match a leaf element
  // whose entire trimmed text equals the label.
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

  function splashDone() {
    try { return sessionStorage.getItem(SPLASH_FLAG) === '1' } catch (e) { return false }
  }
  function markSplashDone() {
    try { sessionStorage.setItem(SPLASH_FLAG, '1') } catch (e) {}
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
  function ensureAttached() {
    var el = document.getElementById(OVERLAY_ID)
    if (el && document.body && el.parentNode !== document.body) document.body.appendChild(el)
  }
  function hideOverlay() {
    var el = document.getElementById(OVERLAY_ID)
    if (el) el.remove()
    markSplashDone()
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

  // On a genspark app page (not the B2C host), logged-in = no visible sign-in
  // trigger once the page has actually rendered.
  function loggedInApp() {
    if (location.hostname === 'login.genspark.ai') return false
    if (document.readyState === 'loading') return false
    if (!document.body || document.body.children.length === 0) return false
    return !hasText(LOGIN_RE)
  }

  function finish() { hideOverlay(); if (obs) obs.disconnect() }

  function tick() {
    if (Date.now() - startedAt > REVEAL_AFTER_MS) { finish(); return }

    if (location.hostname === 'login.genspark.ai') {
      if (b2cError()) { finish(); return }   // surface the error so the user can act
      showOverlay()
      if (!window[DONE] && fillB2C()) window[DONE] = true
      return
    }

    if (location.hostname.endsWith('genspark.ai')) {
      if (loggedInApp()) { finish(); return }
      if (!splashDone()) showOverlay()
      enterLogin()
    }
  }

  obs = new MutationObserver(tick)
  obs.observe(document.documentElement, { childList: true, subtree: true })
  tick()
  setTimeout(finish, REVEAL_AFTER_MS)
}

function buildLoginScript(email, password) {
  return '(' + loginContentMain.toString() + ')(' +
    JSON.stringify(email) + ',' + JSON.stringify(password) + ');'
}

module.exports = { loginContentMain, buildLoginScript }
