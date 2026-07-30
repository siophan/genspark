// Hides specific items in the user (avatar) dropdown menu by their label:
// 商业版, 下载, 帮助. Kept: 设置, 登录.
//
// Why JS and not CSS: 商业版 / 下载 / 设置 are all `div.item` with identical
// classes and no href, so CSS cannot tell them apart — only the text does.
// The menu also mounts only when opened, so an observer re-applies the rule
// each time it appears.
;(() => {
  const HIDE = new Set(['商业版', '下载', '帮助'])

  // Match the exact leaf label, then hide the whole menu item that contains it,
  // so 设置 (same classes as 商业版/下载) is left untouched.
  function hideIn(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!HIDE.has(node.nodeValue.trim())) continue
      const item = node.parentElement?.closest('.item, .help-item')
      if (item) item.style.setProperty('display', 'none', 'important')
    }
  }

  function apply() {
    // Cheap until a menu actually exists (usually zero matches).
    for (const menu of document.querySelectorAll('.dropdown, .help-item')) hideIn(menu)
  }

  apply()
  new MutationObserver(apply).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
})()
