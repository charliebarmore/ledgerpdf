declare module 'proper-lockfile' {
  export interface LockOptions {
    stale?: number
    update?: number
    retries?: number
    realpath?: boolean
    lockfilePath?: string
    /** Called when the lock can no longer be proven ours. The library default rethrows from a timer. */
    onCompromised?: (error: Error) => void
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>
  export function check(file: string, options?: LockOptions): Promise<boolean>
}
