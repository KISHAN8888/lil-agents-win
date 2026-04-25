import koffi from 'koffi'
import { screen } from 'electron'
import log from '../logger'

const FULLSCREEN_RECT = koffi.struct('FULLSCREEN_RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
})

let _GetForegroundWindow: koffi.KoffiFunction | null = null
let _GetWindowRect: koffi.KoffiFunction | null = null

function load(): boolean {
  if (_GetForegroundWindow) return true
  try {
    const user32 = koffi.load('user32.dll')
    _GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', [])
    _GetWindowRect = user32.func('GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(FULLSCREEN_RECT))])
    return true
  } catch (err) {
    log.warn('fullscreen: koffi load failed:', err)
    return false
  }
}

function query(): boolean {
  if (!_GetForegroundWindow || !_GetWindowRect) return false
  try {
    const hwnd = _GetForegroundWindow()
    if (!hwnd) return false

    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    _GetWindowRect(hwnd, rect)

    const { bounds, scaleFactor } = screen.getPrimaryDisplay()
    const sw = Math.round(bounds.width * scaleFactor)
    const sh = Math.round(bounds.height * scaleFactor)

    return rect.left <= 0 && rect.top <= 0 && rect.right >= sw && rect.bottom >= sh
  } catch {
    return false
  }
}

export class FullscreenMonitor {
  private _isFullscreen = false
  private readonly hasFfi: boolean
  private timer: ReturnType<typeof setInterval> | null = null
  private onChange: ((fs: boolean) => void) | null = null

  constructor() {
    this.hasFfi = load()
  }

  start(onChange: (fs: boolean) => void): void {
    this.onChange = onChange
    this.timer = setInterval(() => this.check(), 500)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  get isFullscreen(): boolean { return this._isFullscreen }

  private check(): void {
    if (!this.hasFfi) return
    const next = query()
    if (next !== this._isFullscreen) {
      this._isFullscreen = next
      log.info(`Fullscreen state: ${next}`)
      this.onChange?.(next)
    }
  }
}
