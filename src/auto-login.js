// src/auto-login.js
//
// Browser-side auto-login. Runs in the page main world (injected by the
// preload) on every genspark.ai navigation. If the partition is already
// logged in, none of the target elements exist and it is a no-op. Otherwise
// it either clicks the sign-in entry (landing page) or fills the Azure AD B2C
// form on login.genspark.ai and submits.
//
// NOTE: selectors are DOM-verified against the live genspark.ai login flow
// (landing-page modal trigger + "更多选项" step, then the login.genspark.ai
// Azure B2C form). See loginContentMain for the details captured from
// observation.
function loginContentMain(email, password) {
  var DONE = '__gsAutoLoginFilled'
  var OPENED = '__gsAutoLoginOpened'
  var MORE = '__gsAutoLoginMore'

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
  // whose entire trimmed text equals the label, and click it (or its nearest
  // clickable ancestor).
  function clickByText(re) {
    var els = document.querySelectorAll('a,button,div,span')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.children.length) continue
      if (!re.test((el.textContent || '').trim())) continue
      if (!vis(el)) continue
      ;(el.closest('button') || el.closest('a') || el).click()
      return true
    }
    return false
  }

  function fillB2C() {
    var emailEl = q('#email') || q('input[type=email]') || q('#signInName')
    var passEl = q('#password') || q('input[type=password]')
    if (!emailEl || !passEl) return false
    // The local-account form can be collapsed behind a "Login with email"
    // toggle; reveal it before filling if the fields are not visible yet.
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
    // Once the modal is open, "更多选项" leads to the email/password path on
    // login.genspark.ai. Try it first; it only exists after the modal opens.
    if (!window[MORE] && clickByText(/^(更多选项|more options)$/i)) {
      window[MORE] = true
      return
    }
    // Open the sign-in modal exactly once, so repeated observer ticks do not
    // toggle it shut again.
    if (window[OPENED]) return
    if (clickByText(/^(登\s*录|sign\s?in|log\s?in)$/i)) window[OPENED] = true
  }

  var obs

  function tick() {
    if (window[DONE]) { if (obs) obs.disconnect(); return }
    if (location.hostname === 'login.genspark.ai') {
      if (fillB2C()) { window[DONE] = true; if (obs) obs.disconnect() }
    } else if (location.hostname.endsWith('genspark.ai')) {
      enterLogin()
    }
  }

  obs = new MutationObserver(tick)
  obs.observe(document.documentElement, { childList: true, subtree: true })
  tick()
  setTimeout(function () { if (obs) obs.disconnect() }, 15000)
}

function buildLoginScript(email, password) {
  return '(' + loginContentMain.toString() + ')(' +
    JSON.stringify(email) + ',' + JSON.stringify(password) + ');'
}

module.exports = { loginContentMain, buildLoginScript }
