import {
  MARK_SIZE_DEFAULT,
  MARK_SIZE_MAX,
  MARK_SIZE_MIN,
  isShapeKind,
  normalizeStamp,
  type ToolKind
} from './session'

export type MarkSizePreferences = Record<string, number>

/** Stable identity for a placement tool; lettered stamps remember separately. */
export function markSizePreferenceKey(tool: {
  kind: ToolKind
  text?: string
}): string | null {
  if (tool.kind === 'tape' || isShapeKind(tool.kind)) return null
  if (tool.kind === 'text') {
    const stamp = normalizeStamp(tool.text ?? '')
    return stamp ? `text:${stamp}` : null
  }
  return tool.kind
}

export function clampMarkSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MARK_SIZE_MAX, Math.max(MARK_SIZE_MIN, value))
    : MARK_SIZE_DEFAULT
}

export function preferredMarkSize(
  preferences: MarkSizePreferences,
  tool: { kind: ToolKind; text?: string }
): number {
  const key = markSizePreferenceKey(tool)
  return key ? clampMarkSize(preferences[key]) : MARK_SIZE_DEFAULT
}
