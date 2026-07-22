// Renames the Genspark brand to 老猫 everywhere it shows up on the page.
;(() => {
  const NEW_NAME = '老猫'
  const BRAND = /genspark/gi

  // Text inside these carries meaning beyond the brand name — renaming it
  // would corrupt code samples or break the page.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP'])

  // Attributes the user actually reads. A field's `value` is deliberately
  // absent: that is the user's own text, not ours to rewrite.
  const TEXT_ATTRIBUTES = ['placeholder', 'title', 'alt', 'aria-label', 'aria-placeholder']

  const rename = (text) => text.replace(BRAND, NEW_NAME)

  function renameTextNode(node) {
    if (SKIP_TAGS.has(node.parentNode?.nodeName)) return
    const next = rename(node.nodeValue)
    if (next !== node.nodeValue) node.nodeValue = next
  }

  function renameAttributes(element) {
    for (const name of TEXT_ATTRIBUTES) {
      const value = element.getAttribute?.(name)
      if (value == null) continue
      const next = rename(value)
      if (next !== value) element.setAttribute(name, next)
    }
  }

  function renameTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      renameTextNode(root)
      return
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return

    renameAttributes(root)
    for (const element of root.querySelectorAll?.('*') ?? []) renameAttributes(element)

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) renameTextNode(node)
  }

  function renameTitle() {
    const next = rename(document.title)
    if (next !== document.title) document.title = next
  }

  renameTree(document.body)
  renameTitle()

  // The site renders most of its content after load and rewrites the title on
  // navigation, so keep applying the rename as the page changes. Our own edits
  // leave nothing left to match, so this settles rather than looping.
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') renameTextNode(record.target)
      else if (record.type === 'attributes') renameAttributes(record.target)
      else for (const node of record.addedNodes) renameTree(node)
    }
    renameTitle()
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TEXT_ATTRIBUTES,
  })
})()
