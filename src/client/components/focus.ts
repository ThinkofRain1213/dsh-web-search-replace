/** rc5 自动焦点呈现：自动聚焦不显示环，键盘导航或 blur 后恢复。 */
const releases = new WeakMap<HTMLElement, () => void>()
const navigationKeys = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** 聚焦自动目的地，并在键盘导航时释放自动焦点标记。 */
export function focusWithoutRing(element: HTMLElement, options?: FocusOptions): void {
  releases.get(element)?.()
  const release = (): void => {
    element.removeAttribute('data-dsh-automatic-focus')
    element.removeEventListener('blur', release)
    element.removeEventListener('keydown', navigate, true)
    releases.delete(element)
  }
  const navigate = (event: KeyboardEvent): void => {
    if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && navigationKeys.has(event.key)) release()
  }
  releases.set(element, release)
  element.setAttribute('data-dsh-automatic-focus', '')
  element.addEventListener('blur', release)
  element.addEventListener('keydown', navigate, true)
  element.focus(options)
  if (!element.matches(':focus')) release()
}
