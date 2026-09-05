// Dialogs, dropdowns and toasts.
//
// This replaces window.prompt / window.confirm, which are the single most
// dated-looking thing a web UI can do: they are OS-chrome, unstyleable, block
// the whole page, and on Chrome show a "this page says" prefix. Everything here
// is promise-based, so call sites read the same as before:
//
//     const name = await ask({ title: 'Rename folder', value: folder.title })
//     if (name === null) return          // cancelled
//
// The native <select> gets the same treatment: it cannot be styled beyond its
// border on most platforms, so `dropdown()` builds a real menu instead.

import { el } from './util.js'
import { icon } from './icons.js'

let openLayer = null

function mountLayer({ title, subtitle, body, actions, onEscape, wide = false }) {
  dismissLayer()

  const backdrop = el('div.overlay')
  const panel = el(`div.dialog${wide ? '.dialog--wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' })

  const head = el('div.dialog__head', {}, [
    el('div', {}, [
      el('h2.dialog__title', { text: title }),
      subtitle ? el('p.dialog__subtitle', { text: subtitle }) : null,
    ]),
  ])
  const closeBtn = el('button.icon-btn.dialog__close', { 'aria-label': 'Close' })
  closeBtn.append(icon('close', { size: 16 }))
  closeBtn.addEventListener('click', () => onEscape?.())
  head.append(closeBtn)

  const content = el('div.dialog__body')
  for (const part of [].concat(body)) if (part) content.append(part)

  panel.append(head, content)

  if (actions?.length) {
    panel.append(el('div.dialog__actions', {}, actions.map((a) => {
      const btn = el(`button.btn.${a.tone === 'primary' ? 'btn--primary' : a.tone === 'danger' ? 'btn--danger' : 'btn--quiet'}`, {
        text: a.label,
        onclick: a.onClick,
      })
      if (a.autofocus) requestAnimationFrame(() => btn.focus())
      return btn
    })))
  }

  backdrop.append(panel)
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) onEscape?.() })
  document.body.append(backdrop)

  const onKey = (e) => {
    if (e.key !== 'Escape') return
    // A popover inside the dialog gets first refusal on Escape. This listener
    // is on document in the capture phase, so without the check it would close
    // the whole dialog before an open autocomplete list ever saw the key --
    // dismissing the account suggestions would throw away a half-typed form.
    if (backdrop.querySelector('.suggest.is-open')) return
    e.stopPropagation()
    onEscape?.()
  }
  document.addEventListener('keydown', onKey, true)

  openLayer = { backdrop, onKey }
  requestAnimationFrame(() => backdrop.classList.add('is-open'))
  return { backdrop, panel, content }
}

export function dismissLayer() {
  if (!openLayer) return
  document.removeEventListener('keydown', openLayer.onKey, true)
  openLayer.backdrop.remove()
  openLayer = null
}

export function isDialogOpen() {
  return Boolean(openLayer)
}

/** A styled replacement for window.prompt. Resolves to null when cancelled. */
export function ask({
  title,
  subtitle,
  label,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  multiline = false,
  validate,
}) {
  return new Promise((resolve) => {
    const field = multiline
      ? el('textarea.field', { rows: 4, placeholder })
      : el('input.field', { type: 'text', placeholder, autocomplete: 'off' })
    field.value = value

    const error = el('p.field__error')

    const done = (result) => { dismissLayer(); resolve(result) }
    const submit = () => {
      const next = field.value.trim()
      const problem = validate?.(next)
      if (problem) { error.textContent = problem; field.focus(); return }
      done(next)
    }

    field.addEventListener('input', () => { error.textContent = '' })
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
    })

    mountLayer({
      title,
      subtitle,
      body: [label ? el('label.field__label', { text: label }) : null, field, error],
      actions: [
        { label: 'Cancel', onClick: () => done(null) },
        { label: confirmLabel, tone: 'primary', onClick: submit },
      ],
      onEscape: () => done(null),
    })

    requestAnimationFrame(() => { field.focus(); field.select?.() })
  })
}

/** A styled replacement for window.confirm. */
export function confirmAction({ title, subtitle, confirmLabel = 'Delete', tone = 'danger' }) {
  return new Promise((resolve) => {
    const done = (result) => { dismissLayer(); resolve(result) }
    mountLayer({
      title,
      subtitle,
      body: [],
      actions: [
        { label: 'Cancel', onClick: () => done(false) },
        { label: confirmLabel, tone, onClick: () => done(true), autofocus: true },
      ],
      onEscape: () => done(false),
    })
  })
}

/** A general dialog with custom content. Returns the content node to fill. */
export function dialog(options) {
  return mountLayer({ ...options, onEscape: options.onEscape ?? dismissLayer })
}

// ------------------------------------------------------------------ menus ---

let openMenuNode = null

export function closeMenu() {
  if (openMenuNode?._dismiss) document.removeEventListener('click', openMenuNode._dismiss, true)
  openMenuNode?.remove()
  openMenuNode = null
}

/**
 * A floating menu anchored to a point or an element.
 * Entries: {label, iconName?, tone?, onClick} | {separator:true} | {heading}
 *          | {swatches:[...], onPick} | {choices:[{value,label}], value, onPick}
 */
export function menu(anchor, entries) {
  closeMenu()

  const node = el('div.menu', { role: 'menu' })

  for (const entry of entries) {
    if (!entry) continue

    if (entry.separator) { node.append(el('div.menu__rule')); continue }

    if (entry.heading) { node.append(el('div.menu__heading', { text: entry.heading })); continue }

    if (entry.swatches) {
      node.append(el('div.menu__swatches', {}, entry.swatches.map((color) => {
        const dot = el('button.swatch', { style: { '--swatch': color }, title: color })
        dot.style.setProperty('--swatch', color)
        if (entry.value === color) dot.classList.add('is-active')
        dot.addEventListener('click', () => { closeMenu(); entry.onPick(color) })
        return dot
      })))
      continue
    }

    if (entry.choices) {
      node.append(el('div.menu__choices', {}, entry.choices.map((choice) => {
        const btn = el(`button.chip${entry.value === choice.value ? '.is-active' : ''}`, { text: choice.label })
        btn.addEventListener('click', () => { closeMenu(); entry.onPick(choice.value) })
        return btn
      })))
      continue
    }

    const item = el(`button.menu__item${entry.tone === 'danger' ? '.menu__item--danger' : ''}`, { role: 'menuitem' })
    if (entry.iconName) item.append(icon(entry.iconName, { size: 15 }))
    item.append(el('span', { text: entry.label }))
    if (entry.hint) item.append(el('kbd.menu__hint', { text: entry.hint }))
    item.addEventListener('click', () => { closeMenu(); entry.onClick?.() })
    node.append(item)
  }

  document.body.append(node)
  position(node, anchor)
  openMenuNode = node

  // Armed on the next tick so the click that opened this menu cannot close it.
  setTimeout(() => {
    if (openMenuNode !== node) return
    const dismiss = (ev) => {
      if (ev.target.closest('.menu')) return
      document.removeEventListener('click', dismiss, true)
      closeMenu()
    }
    document.addEventListener('click', dismiss, true)
    node._dismiss = dismiss
  }, 0)

  requestAnimationFrame(() => node.classList.add('is-open'))
  return node
}

function position(node, anchor) {
  const gap = 6
  const rect = node.getBoundingClientRect()
  let x
  let y

  if (anchor instanceof Element) {
    const box = anchor.getBoundingClientRect()
    x = box.left
    y = box.bottom + gap
    if (x + rect.width > window.innerWidth - 8) x = box.right - rect.width
    if (y + rect.height > window.innerHeight - 8) y = box.top - rect.height - gap
  } else {
    x = anchor.clientX
    y = anchor.clientY
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8
  }

  node.style.left = `${Math.max(8, x)}px`
  node.style.top = `${Math.max(8, y)}px`
}

/**
 * A styled stand-in for <select>. Renders as a button that opens a menu, so it
 * matches the rest of the UI instead of the operating system's widget.
 */
export function dropdown({ value, choices, onChange, width }) {
  const label = () => choices.find((c) => c.value === value)?.label ?? ''

  const btn = el('button.select', { type: 'button' })
  if (width) btn.style.minWidth = `${width}px`

  const text = el('span.select__value', { text: label() })
  btn.append(text, icon('chevronDown', { size: 14, className: 'select__caret' }))

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    menu(btn, choices.map((choice) => ({
      label: choice.label,
      iconName: choice.value === value ? 'check' : undefined,
      onClick: () => { value = choice.value; text.textContent = label(); onChange(choice.value) },
    })))
  })

  return btn
}
