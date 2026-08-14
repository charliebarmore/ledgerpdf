/**
 * The binder path a launch was handed on its command line, if any.
 *
 * Windows and Linux deliver Explorer's double-click / Open With as a plain
 * argv entry — on a warm launch via `second-instance`, on a cold launch via
 * this process's own argv. One rule for both, so the two doors cannot drift:
 * skip the executable, ignore flags, and take the first `.pdf`.
 */
export function argvOpenTarget(argv: string[]): string | null {
  return (
    argv.slice(1).find((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.pdf')) ?? null
  )
}
