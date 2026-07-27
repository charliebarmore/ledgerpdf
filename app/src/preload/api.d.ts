import type { WptApi } from './index'

declare global {
  interface Window {
    wpt: WptApi
  }
}

export {}
