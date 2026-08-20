// src/auto-login.js
//
// Browser-side auto-login. Runs in the page main world (injected by the
// preload) on every genspark.ai navigation. If the partition is already
// logged in, none of the target elements exist and it is a no-op. Otherwise
// it either clicks the sign-in entry (landing page) or fills the Azure AD B2C
// form on login.genspark.ai and submits.
//
// NOTE: selectors are a best-effort first pass. Task 6 verifies them against
// the live DOM and tightens them if needed.
function loginContentMain(email, password) {
  var DONE = '__gsAutoLoginFilled'
  var ENTERED = '__gsAutoLoginEntered'

  function q(sel) { return document.querySelector(sel) }

  function setValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function fillB2C() {
    var emailEl = q('input[type=email]') || q('#email') || q('#signInName') || q('input[name=Email]')
    var passEl = q('input[type=password]') || q('#password') || q('input[name=Password]')
    if (!emailEl || !passEl) return false
    setValue(emailEl, email)
    setValue(passEl, password)
    var submit = q('button[type=submit]') || q('#next') || q('#continue') || q('#submit')
    if (submit) submit.click()
    return true
  }

  function enterLogin() {
    if (window[ENTERED]) return
    var els = Array.prototype.slice.call(document.querySelectorAll('a,button'))
    var hit = els.find(function (el) {
      return /^(sign ?in|log ?in|登\s*录)$/i.test((el.textContent || '').trim())
    })
    if (hit) { window[ENTERED] = true; hit.click() }
  }

  var obs

  function tick() {
    if (window[DONE]) { if (obs) obs.disconnect(); return }
    if (location.hostname === 'login.genspark.ai') {
      if (fillB2C()) window[DONE] = true
    } else if (location.hostname.endsWith('genspark.ai')) {
      enterLogin()
    }
  }

  obs = new MutationObserver(tick)
  obs.observe(document.documentElement, { childList: true, subtree: true })
  tick()
  setTimeout(function () { obs.disconnect() }, 15000)
}

function buildLoginScript(email, password) {
  return '(' + loginContentMain.toString() + ')(' +
    JSON.stringify(email) + ',' + JSON.stringify(password) + ');'
}

module.exports = { loginContentMain, buildLoginScript }
