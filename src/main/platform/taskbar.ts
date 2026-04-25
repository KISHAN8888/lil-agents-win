import koffi from 'koffi'
import { EventEmitter } from 'events'
import { screen } from 'electron'
import type { TaskbarGeometry, TaskbarEdge } from '../../shared/types'
import log from '../logger'

const ABM_GETSTATE = 4
const ABM_GETTASKBARPOS = 5
const ABE_LEFT = 0
const ABE_TOP = 1
const ABE_RIGHT = 2
// ABE_BOTTOM = 3 (default)
const ABS_AUTOHIDE = 1

// --- koffi type definitions (module-level singletons) ---
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
})

// APPBARDATA layout on 64-bit Windows (48 bytes):
//   cbSize(4) + pad(4) + hWnd*(8) + uCallbackMessage(4) + uEdge(4) + RECT(16) + lParam(8)
const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'void *',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr',
})

const STRUCT_SIZE = koffi.sizeof(APPBARDATA)

let SHAppBarMessage: koffi.KoffiFunction | null = null

function loadSHAppBarMessage(): boolean {
  if (SHAppBarMessage) return true
  try {
    const shell32 = koffi.load('shell32.dll')
    SHAppBarMessage = shell32.func(
      'SHAppBarMessage',
      'uint32',
      ['uint32', koffi.inout(koffi.pointer(APPBARDATA))]
    )
    log.info(`SHAppBarMessage loaded (APPBARDATA size=${STRUCT_SIZE})`)
    return true
  } catch (err) {
    log.warn('koffi/SHAppBarMessage load failed — using fallback:', err)
    return false
  }
}

function makeData() {
  return {
    cbSize: STRUCT_SIZE,
    hWnd: null,
    uCallbackMessage: 0,
    uEdge: 3, // ABE_BOTTOM default
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam: 0,
  }
}

function edgeFromUint(uEdge: number): TaskbarEdge {
  switch (uEdge) {
    case ABE_LEFT:
      return 'left'
    case ABE_TOP:
      return 'top'
    case ABE_RIGHT:
      return 'right'
    default:
      return 'bottom'
  }
}

function queryViaFfi(): TaskbarGeometry | null {
  if (!SHAppBarMessage) return null
  try {
    const posData = makeData()
    SHAppBarMessage(ABM_GETTASKBARPOS, posData)

    const stateData = makeData()
    const state = SHAppBarMessage(ABM_GETSTATE, stateData) as number
    const autoHide = Boolean(state & ABS_AUTOHIDE)

    const rc = posData.rc as { left: number; top: number; right: number; bottom: number }
    const uEdge = posData.uEdge as number
    const edge = edgeFromUint(uEdge)

    // Convert from physical pixels (SHAppBarMessage coords) to CSS pixels
    const { scaleFactor } = screen.getPrimaryDisplay()
    const x = Math.round(rc.left / scaleFactor)
    const y = Math.round(rc.top / scaleFactor)
    const w = Math.round((rc.right - rc.left) / scaleFactor)
    const h = Math.round((rc.bottom - rc.top) / scaleFactor)

    return { edge, rect: { x, y, w, h }, autoHide, isVisible: !autoHide }
  } catch (err) {
    log.warn('SHAppBarMessage query error:', err)
    return null
  }
}

/** Fallback: infer taskbar rect from Electron workArea */
function queryFallback(): TaskbarGeometry {
  const d = screen.getPrimaryDisplay()
  const { bounds, workArea } = d

  const gaps = {
    bottom: bounds.height - (workArea.y + workArea.height),
    top: workArea.y,
    left: workArea.x,
    right: bounds.width - (workArea.x + workArea.width),
  }

  const edge = (Object.keys(gaps) as TaskbarEdge[]).reduce((a, b) => (gaps[a] >= gaps[b] ? a : b))

  let rect: TaskbarGeometry['rect']
  switch (edge) {
    case 'bottom':
      rect = { x: 0, y: workArea.y + workArea.height, w: bounds.width, h: gaps.bottom }
      break
    case 'top':
      rect = { x: 0, y: 0, w: bounds.width, h: gaps.top }
      break
    case 'left':
      rect = { x: 0, y: 0, w: gaps.left, h: bounds.height }
      break
    case 'right':
      rect = { x: workArea.x + workArea.width, y: 0, w: gaps.right, h: bounds.height }
      break
  }

  return { edge, rect, autoHide: false, isVisible: true }
}

// ---------------------------------------------------------------

export class TaskbarMonitor extends EventEmitter {
  private current: TaskbarGeometry | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly hasFfi: boolean

  constructor() {
    super()
    this.hasFfi = loadSHAppBarMessage()
  }

  start(): void {
    this.refresh()
    this.pollTimer = setInterval(() => this.refresh(), 1000)
    screen.on('display-metrics-changed', () => this.refresh())
    screen.on('display-added', () => this.refresh())
    screen.on('display-removed', () => this.refresh())
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  get geometry(): TaskbarGeometry | null {
    return this.current
  }

  private refresh(): void {
    const next = (this.hasFfi ? queryViaFfi() : null) ?? queryFallback()

    const prev = this.current
    if (!prev || !geometryEqual(prev, next)) {
      this.current = next
      log.info(
        `Taskbar: edge=${next.edge} rect=${JSON.stringify(next.rect)} autoHide=${next.autoHide}`
      )
      this.emit('change', next)
    }
  }

  override on(event: 'change', listener: (geometry: TaskbarGeometry) => void): this {
    return super.on(event, listener)
  }
}

function geometryEqual(a: TaskbarGeometry, b: TaskbarGeometry): boolean {
  return (
    a.edge === b.edge &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.w === b.rect.w &&
    a.rect.h === b.rect.h &&
    a.autoHide === b.autoHide
  )
}
