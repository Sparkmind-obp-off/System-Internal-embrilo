// Runs before first paint (external file, so the strict CSP needs no 'unsafe-inline').
// Marks the document as motion-capable so entrance elements start hidden instead of flickering.
// CSS reveals everything after 1.5s even if the main script never loads.
if (window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion')
}
