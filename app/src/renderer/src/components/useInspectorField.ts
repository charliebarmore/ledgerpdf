import { useRef, useState } from 'react'

/** Keep review text in the session as it is typed, even if its panel unmounts.
 * A focus gesture is one undo group; Escape restores the value at focus.
 */
export function useInspectorField(
  value: string,
  onChange: (value: string, group: symbol, cancel?: boolean) => void,
  allowEmpty = true
) {
  // Only retain a local draft while the model cannot represent it (an empty
  // lettered stamp). A changed model value, including undo, always wins.
  const [local, setLocal] = useState<{ source: string; value: string } | null>(null)
  const draft = local?.source === value ? local.value : value
  const setDraft = (next: string): void => {
    setLocal(!allowEmpty && !next.trim() ? { source: value, value: next } : null)
  }
  const gesture = useRef({ group: Symbol(), original: value, published: value })
  const syncGesture = (): void => {
    // Undo or another editor may replace the field while it has focus. A later
    // blur/Escape must never republish our earlier draft over that replacement.
    if (gesture.current.published !== value) {
      gesture.current = { group: Symbol(), original: value, published: value }
    }
  }

  const publish = (text: string, cancel = false): void => {
    if ((allowEmpty || text.trim()) && (text !== value || cancel)) {
      gesture.current.published = text
      onChange(text, gesture.current.group, cancel)
    }
  }

  return {
    value: draft,
    onFocus: (): void => { gesture.current = { group: Symbol(), original: value, published: value } },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      syncGesture()
      setDraft(e.target.value)
      publish(e.target.value)
    },
    onBlur: (): void => {
      syncGesture()
      const normalized = draft.trim()
      if (!allowEmpty && !normalized) setDraft(value)
      else { setDraft(normalized); publish(normalized) }
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      if (e.key === 'Escape') {
        syncGesture()
        // Do not blur synchronously: the blur closure still holds the old draft.
        e.preventDefault()
        e.stopPropagation()
        setDraft(gesture.current.original)
        publish(gesture.current.original, true)
      } else if (e.key === 'Enter' && (e.currentTarget.tagName === 'INPUT' || e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.currentTarget.blur()
      }
    }
  }
}
