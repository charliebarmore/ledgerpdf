declare module 'proper-lockfile' {
  export interface LockOptions {
    stale?: number
    update?: number
    retries?: number
    realpath?: boolean
    lockfilePath?: string
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>
  export function check(file: string, options?: LockOptions): Promise<boolean>
}
