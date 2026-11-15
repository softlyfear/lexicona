let dirty = false

export function setDraftDirty(value: boolean) {
  dirty = value
}

export function isDraftDirty() {
  return dirty
}

export function confirmDraftLeave(): boolean {
  if (!dirty) return true
  return window.confirm('Несохранённые изменения будут потеряны. Продолжить?')
}
