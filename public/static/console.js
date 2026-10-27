// Embrilo OS console helpers. No inline scripts (strict CSP). Progressive enhancement only.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]')
  if (!btn) return
  const el = document.querySelector(btn.getAttribute('data-copy'))
  if (!el) return
  try {
    await navigator.clipboard.writeText(el.value || el.textContent || '')
    const old = btn.textContent
    btn.textContent = 'Copied ✓'
    setTimeout(() => (btn.textContent = old), 1500)
  } catch {
    el.select && el.select()
  }
})
// Prevent double submission of state-changing forms.
document.addEventListener('submit', (e) => {
  const form = e.target
  if (form.dataset.submitting) return e.preventDefault()
  form.dataset.submitting = '1'
  setTimeout(() => delete form.dataset.submitting, 4000)
})
