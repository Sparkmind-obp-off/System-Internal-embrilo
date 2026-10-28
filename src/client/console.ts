// Embrilo OS — progressive enhancement for the server-rendered console.
// Everything here is optional: pages are complete and usable without JavaScript.
// Bundled by esbuild into /static/console.js (no inline scripts → strict CSP stays intact).
import { animate } from 'animejs/animation'
import { createTimeline } from 'animejs/timeline'
import { stagger } from 'animejs/utils'
import { createDrawable } from 'animejs/svg'

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const EASE = 'outQuart'

// ---------------------------------------------------------------------------
// Motion layer (Anime.js v4). Transform/opacity only, short durations, run once per page load.
// ---------------------------------------------------------------------------
const reveal = (els: Iterable<Element>) => {
  for (const el of els) el.classList.add('is-shown')
}

function runEntrance() {
  const root = document.documentElement
  if (root.dataset.motionDone) return // guard against double initialisation
  root.dataset.motionDone = '1'
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-animate]'))
  if (reduceMotion.matches || !root.classList.contains('motion')) {
    reveal(all)
    return
  }

  const enter = Array.from(document.querySelectorAll<HTMLElement>('[data-animate="enter"]')).slice(0, 8)
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-animate="item"]')).slice(0, 12)
  // Only animate rows that are visible on first paint; long lists appear instantly below the fold.
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-animate="row"]')).slice(0, 14)

  const tl = createTimeline({ defaults: { ease: EASE } })
  if (enter.length) tl.add(enter, { opacity: [0, 1], translateY: [10, 0], duration: 420, delay: stagger(55) }, 0)
  if (items.length) tl.add(items, { opacity: [0, 1], translateY: [8, 0], duration: 360, delay: stagger(40) }, 80)
  if (rows.length) tl.add(rows, { opacity: [0, 1], translateX: [-6, 0], duration: 300, delay: stagger(28) }, 160)

  // Workflow stepper: draw the progress line to the current step (SVG line drawing).
  const line = document.querySelector<SVGLineElement>('[data-animate="draw"]')
  if (line) tl.add(createDrawable(line), { draw: ['0 0', '0 1'], duration: 700, ease: 'inOutQuad' }, 120)
  const current = document.querySelector<HTMLElement>('.step-current .step-dot')
  if (current) tl.add(current, { scale: [0.6, 1], duration: 380, ease: 'outBack(1.6)' }, 520)

  // Metric bars grow from the left (transform, not width, to avoid layout work).
  const bars = Array.from(document.querySelectorAll<HTMLElement>('[data-animate="bar"]'))
  if (bars.length) tl.add(bars, { scaleX: [0, 1], duration: 520, delay: stagger(45) }, 200)

  // Elements not choreographed (long lists below the fold, draw line, etc.) show immediately.
  const animated = new Set<Element>([...enter, ...items, ...rows])
  reveal(all.filter((el) => !animated.has(el)))
  // Choreographed elements: the timeline holds them at opacity 0 until their tween starts
  // (inline style beats the CSS rule), so revealing the class now causes no flash.
  for (const el of animated) (el as HTMLElement).style.opacity = '0'
  reveal(animated)
  tl.then(() => {
    for (const el of animated) {
      ;(el as HTMLElement).style.removeProperty('opacity')
      ;(el as HTMLElement).style.removeProperty('transform')
    }
  })
}

function flashFeedback() {
  const alerts = document.querySelectorAll<HTMLElement>('[data-animate="flash"]')
  if (!alerts.length || reduceMotion.matches) return
  animate(alerts, { opacity: [0, 1], translateY: [-6, 0], duration: 320, ease: EASE })
}

// ---------------------------------------------------------------------------
// Toasts (polite live region). Used for copy confirmation.
// ---------------------------------------------------------------------------
function toast(message: string, tone: 'success' | 'danger' = 'success') {
  const region = document.getElementById('toast-region')
  if (!region) return
  const el = document.createElement('div')
  el.className = `toast toast-${tone}`
  el.textContent = message // textContent: never interpret as HTML
  region.appendChild(el)
  const remove = () => el.remove()
  if (reduceMotion.matches) {
    setTimeout(remove, 2600)
    return
  }
  animate(el, { opacity: [0, 1], translateY: [8, 0], duration: 240, ease: EASE })
  setTimeout(() => animate(el, { opacity: [1, 0], duration: 220, ease: 'inQuad', onComplete: remove }), 2400)
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard for the sanitized prompt (button is hidden until JS is available).
// ---------------------------------------------------------------------------
function setupCopy() {
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.hidden = false
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      const target = document.querySelector<HTMLTextAreaElement>(btn.dataset.copy ?? '')
      if (!target) return
      const label = btn.querySelector<HTMLElement>('[data-copy-label]')
      const original = label?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(target.value)
        if (label) label.textContent = 'Tersalin'
        btn.classList.add('is-done')
        toast(btn.dataset.copyToast ?? 'Prompt tersalin. Tempel di alat AI Anda — belum ada yang dieksekusi.')
        setTimeout(() => {
          if (label) label.textContent = original
          btn.classList.remove('is-done')
        }, 2200)
      } catch {
        target.focus()
        target.select()
        toast('Tidak bisa menyalin otomatis — teks sudah dipilih, tekan Ctrl/⌘+C.', 'danger')
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Show/hide password toggle (login).
// ---------------------------------------------------------------------------
function setupPasswordToggle() {
  document.querySelectorAll<HTMLButtonElement>('[data-toggle-password]').forEach((btn) => {
    const input = document.querySelector<HTMLInputElement>(btn.dataset.togglePassword ?? '')
    if (!input || btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.hidden = false
    btn.setAttribute('aria-pressed', 'false')
    btn.addEventListener('click', () => {
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      btn.textContent = show ? 'Sembunyikan' : 'Tampilkan'
      btn.setAttribute('aria-pressed', String(show))
      input.focus()
    })
  })
}

// ---------------------------------------------------------------------------
// Submit state: prevent accidental double submission, but never trap the user.
// The button shows a progress label; it is restored if the page is kept (bfcache) or after 8s.
// ---------------------------------------------------------------------------
function setupSubmitState() {
  document.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement
    if (form.method.toLowerCase() !== 'post') return
    if (form.dataset.submitting === '1') {
      e.preventDefault()
      return
    }
    form.dataset.submitting = '1'
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null
    if (submitter) {
      const label = submitter.dataset.submitLabel ?? form.dataset.submitLabel
      if (label) {
        submitter.dataset.originalHtml = submitter.innerHTML
        submitter.textContent = label
      }
      submitter.setAttribute('aria-busy', 'true')
      submitter.classList.add('is-busy')
    }
    setTimeout(() => restore(form), 8000)
  })
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) document.querySelectorAll<HTMLFormElement>('form[data-submitting]').forEach(restore)
  })
}

function restore(form: HTMLFormElement) {
  delete form.dataset.submitting
  form.querySelectorAll<HTMLButtonElement>('[aria-busy="true"]').forEach((b) => {
    if (b.dataset.originalHtml !== undefined) {
      b.innerHTML = b.dataset.originalHtml
      delete b.dataset.originalHtml
    }
    b.removeAttribute('aria-busy')
    b.classList.remove('is-busy')
  })
}

// ---------------------------------------------------------------------------
// Focus the first invalid field after a server-side validation error.
// ---------------------------------------------------------------------------
function focusFirstError() {
  const invalid = document.querySelector<HTMLElement>('[aria-invalid="true"], .has-error input, .has-error textarea, .has-error select')
  if (invalid) {
    invalid.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' })
    invalid.focus({ preventScroll: true })
  }
}

// ---------------------------------------------------------------------------
// Clean up the ?ok=/?err= flash parameters so a refresh doesn't repeat the message.
// ---------------------------------------------------------------------------
function cleanFlashParams() {
  const url = new URL(window.location.href)
  if (url.searchParams.has('ok') || url.searchParams.has('err')) {
    url.searchParams.delete('ok')
    url.searchParams.delete('err')
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash)
  }
}

function init() {
  setupCopy()
  setupPasswordToggle()
  setupSubmitState()
  focusFirstError()
  try {
    runEntrance()
    flashFeedback()
  } catch {
    // Animation is decoration only; any failure leaves the static page intact and visible.
    document.querySelectorAll<HTMLElement>('[data-animate]').forEach((el) => {
      el.style.removeProperty('opacity')
      el.style.removeProperty('transform')
      el.classList.add('is-shown')
    })
  }
  cleanFlashParams()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true })
else init()
