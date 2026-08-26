import type { BallApi } from '../../electron/preload'

declare global {
  interface Window {
    api: BallApi
  }
}

export {}
