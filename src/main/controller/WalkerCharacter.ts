import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import koffi from 'koffi'
import { IPC } from '../ipc/channels'
import { ClaudeSession } from '../sessions/ClaudeSession'
import store from '../store'
import log from '../logger'
import type { TaskbarGeometry, CharacterName, CharacterSize, ThemeName } from '../../shared/types'

// Detect mouse button clicks natively — the only reliable approach when
// the walker window has focusable:false (WS_EX_NOACTIVATE), which causes
// Chromium to silently discard WM_LBUTTONDOWN before it reaches the DOM.
const _user32 = koffi.load('user32.dll')
const GetAsyncKeyState: (vKey: number) => number = _user32.func('GetAsyncKeyState', 'short', ['int'])
const VK_LBUTTON = 0x01

// ---- character params (ported from WalkerCharacter.swift) ----

interface CharacterParams {
  name: CharacterName
  videoFile: string
  videoDurationSec: number
  accelStart: number
  fullSpeedStart: number
  decelStart: number
  walkStop: number
  walkAmountRange: [number, number]
  yOffset: number
}

const BRUCE_PARAMS: CharacterParams = {
  name: 'bruce',
  videoFile: 'walk-bruce-01.webm',
  videoDurationSec: 10.0,
  accelStart: 3.0,
  fullSpeedStart: 3.75,
  decelStart: 8.0,
  walkStop: 8.5,
  walkAmountRange: [0.4, 0.65],
  yOffset: 25,
}

const JAZZ_PARAMS: CharacterParams = {
  name: 'jazz',
  videoFile: 'walk-jazz-01.webm',
  videoDurationSec: 10.0,
  accelStart: 3.9,
  fullSpeedStart: 4.5,
  decelStart: 8.0,
  walkStop: 8.75,
  walkAmountRange: [0.35, 0.6],
  yOffset: 25,
}

export const CHARACTER_PARAMS: Record<CharacterName, CharacterParams> = {
  bruce: BRUCE_PARAMS,
  jazz: JAZZ_PARAMS,
}

// ---- size constants ----

const SIZE_HEIGHT: Record<string, number> = { large: 150, medium: 112, small: 75 }

// Extra window height above character to accommodate the speech bubble.
const BUBBLE_H = 70

const THINKING_PHRASES = ['pondering...', 'thinking...', 'on it...', 'hm...']

// Pings that play as thinking phrases cycle — lower notes for calm "working" feel
const THINKING_PINGS = [
  'sounds/ping-aa.mp3',
  'sounds/ping-bb.mp3',
  'sounds/ping-cc.mp3',
  'sounds/ping-dd.mp3',
]
const COMPLETE_PING = 'sounds/ping-jj.m4a'

const POPOVER_W = 520
const POPOVER_H = 380

function randomInRange([lo, hi]: [number, number]): number {
  return lo + Math.random() * (hi - lo)
}

function charToWindow(charH: number): { winW: number; winH: number } {
  return { winW: Math.round(charH * (9 / 16)), winH: charH + BUBBLE_H }
}

// ---- walk state machine ----

type WalkState = 'idle' | 'walking'

export class WalkerCharacter {
  private readonly params: CharacterParams
  readonly win: BrowserWindow
  private popoverWin: BrowserWindow | null = null

  private state: WalkState = 'idle'
  private visible = true
  private clickable = false
  private lastPopoverToggle = 0
  private rendererReady = false
  private walkerReady = false
  private pendingBubble: string | null = null
  private session: ClaudeSession | null = null
  private thinkingActive = false
  private toolBubbleActive = false
  private thinkingPhraseIdx = 0
  private thinkingTimer: ReturnType<typeof setInterval> | null = null
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private clickReady = false
  private walkPaused = false
  private pendingUserMessage: string | null = null
  private currentResponseText = ''
  private positionProgress = 0.5 + (Math.random() - 0.5) * 0.4 // 0.3..0.7 start
  private direction: 1 | -1 = Math.random() < 0.5 ? 1 : -1
  private lastSentFlipped: boolean | null = null

  // idle
  private pauseMs = 500 + Math.random() * 1500 // initial random pause

  // walking
  private walkStartProgress = 0
  private walkEndProgress = 0
  private walkTimer = 0
  private walkDurationMs = 0

  private taskbar: TaskbarGeometry | null = null

  constructor(name: CharacterName) {
    this.params = CHARACTER_PARAMS[name]
    const size = store.get(`${name}.size`, 'large') as string
    const charH = SIZE_HEIGHT[size] ?? SIZE_HEIGHT.large
    const { winW, winH } = charToWindow(charH)

    this.win = new BrowserWindow({
      width: winW,
      height: winH,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/walker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setIgnoreMouseEvents(true, { forward: true })

    const char = this.params.name
    if (process.env['ELECTRON_RENDERER_URL']) {
      this.win.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}/walker/index.html?char=${char}`
      )
    } else {
      this.win.loadFile(join(__dirname, '../renderer/walker/index.html'), {
        query: { char },
      })
    }

    log.info(`WalkerCharacter(${char}) window ${winW}x${winH} (charH=${charH}+bubble=${BUBBLE_H})`)

    // Drain the "pressed since last call" low bit so a recent Enter/click
    // (e.g. from running `npm run dev`) doesn't trigger a spurious popover
    // on the very first tick before any human click has occurred.
    GetAsyncKeyState(VK_LBUTTON)
    setTimeout(() => { this.clickReady = true }, 500)
  }

  get popover(): BrowserWindow | null {
    return this.popoverWin
  }

  updateTaskbar(geometry: TaskbarGeometry): void {
    this.taskbar = geometry
    this.applyBounds()
  }

  /** Called every ~16ms by the tick loop. dt = delta time in ms. */
  tick(dt: number): void {
    if (!this.taskbar) return

    if (!this.walkPaused) {
      if (this.state === 'idle') {
        this.pauseMs -= dt
        if (this.pauseMs <= 0) this.startWalk()
      } else {
        this.walkTimer += dt
        const t = Math.min(this.walkTimer / this.walkDurationMs, 1)
        this.positionProgress =
          this.walkStartProgress + (this.walkEndProgress - this.walkStartProgress) * t

        if (t >= 1) {
          this.positionProgress = this.walkEndProgress
          this.state = 'idle'
          this.pauseMs = 500 + Math.random() * 1500
          this.walkTimer = 0
          if (this.positionProgress <= 0) this.direction = 1
          else if (this.positionProgress >= 1) this.direction = -1
          if (!this.win.isDestroyed()) this.win.webContents.send(IPC.WALKER_WALKING, false)
          log.debug(`WalkerCharacter(${this.params.name}) walk complete → idle`)
        }
      }
    }

    this.syncFlip()
    this.applyBounds()
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Called every tick — detects hover and clicks natively via Win32. */
  updateClickState(): void {
    if (!this.clickReady) return
    const cursor = screen.getCursorScreenPoint()
    const b = this.win.getBounds()

    // Only the character zone (below bubble) is interactive
    const inside =
      cursor.x >= b.x && cursor.x < b.x + b.width &&
      cursor.y >= b.y + BUBBLE_H && cursor.y < b.y + b.height

    if (inside !== this.clickable) {
      this.clickable = inside
      this.win.setIgnoreMouseEvents(!inside, { forward: true })
    }

    // GetAsyncKeyState low bit = button pressed since last call.
    // We must read it every tick so the bit is consumed and not re-triggered.
    const clicked = inside && !!(GetAsyncKeyState(VK_LBUTTON) & 1)
    if (clicked) this.togglePopover()
  }

  togglePopover(): void {
    const now = Date.now()
    if (now - this.lastPopoverToggle < 500) return
    this.lastPopoverToggle = now

    if (!this.popoverWin || this.popoverWin.isDestroyed()) {
      this.popoverWin = this.createPopover()
      this.rendererReady = false
    }

    if (this.popoverWin.isVisible()) {
      this.popoverWin.hide()
    } else {
      this.positionPopover()
      this.popoverWin.show()
      // Session starts via onRendererReady() on first open.
      // On subsequent opens, restart if the session died.
      if (this.rendererReady && !this.session?.isRunning) {
        void this.startSession()
      }
      // Attach blur-to-hide after 300ms so the OS click-event cycle finishes
      // before we start listening — otherwise blur fires immediately on Windows
      const win = this.popoverWin
      setTimeout(() => {
        if (!win.isDestroyed() && win.isVisible()) {
          win.once('blur', () => win.hide())
        }
      }, 300)
    }
  }

  onRendererReady(): void {
    this.rendererReady = true
    const history = store.get(this.params.name).history ?? []
    const wc = this.popoverWin?.webContents
    if (history.length > 0 && wc && !wc.isDestroyed()) {
      wc.send(IPC.SESSION_HISTORY, history)
    }
    void this.startSession()
  }

  hidePopover(): void {
    this.popoverWin?.hide()
  }

  onWalkerReady(): void {
    this.walkerReady = true
    if (!this.win.isDestroyed()) {
      if (this.state === 'walking' && !this.walkPaused) {
        this.win.webContents.send(IPC.WALKER_WALKING, true, this.params.accelStart)
      } else {
        this.win.webContents.send(IPC.WALKER_WALKING, false)
      }
    }
    if (this.pendingBubble !== null) {
      this.showBubble(this.pendingBubble)
      this.pendingBubble = null
    }
  }

  showBubble(text: string, variant: 'default' | 'complete' = 'default'): void {
    if (!this.walkerReady) {
      this.pendingBubble = text
      return
    }
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.BUBBLE_SHOW, text, variant)
  }

  hideBubble(): void {
    this.pendingBubble = null
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.BUBBLE_HIDE)
  }

  private sendSound(file: string): void {
    if (store.get('soundEnabled') && !this.win.isDestroyed())
      this.win.webContents.send(IPC.WALKER_SOUND, file)
  }

  private startThinking(): void {
    this.stopThinking()
    this.walkPaused = true
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.WALKER_WALKING, false)
    this.thinkingActive = true
    this.thinkingPhraseIdx = 0
    this.showBubble(THINKING_PHRASES[0])
    this.sendSound(THINKING_PINGS[0])
    this.thinkingTimer = setInterval(() => {
      this.thinkingPhraseIdx = (this.thinkingPhraseIdx + 1) % THINKING_PHRASES.length
      this.showBubble(THINKING_PHRASES[this.thinkingPhraseIdx])
      this.sendSound(THINKING_PINGS[this.thinkingPhraseIdx % THINKING_PINGS.length])
    }, 2000)
  }

  private stopThinking(): void {
    if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = null }
    this.thinkingActive = false
    this.toolBubbleActive = false
    this.walkPaused = false
    if (this.state === 'walking' && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.WALKER_WALKING, true, this.params.accelStart)
    }
  }

  private showCompletion(): void {
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null }
    this.showBubble('done!', 'complete')
    this.sendSound(COMPLETE_PING)
    this.completionTimer = setTimeout(() => {
      this.hideBubble()
      this.completionTimer = null
    }, 3000)
  }

  // ---- session management ----

  async startSession(): Promise<void> {
    // Guard on non-null: session is either already running or still starting.
    // StrictMode double-invokes effects → POPOVER_READY fires twice; this
    // prevents a second ClaudeSession from being created during that window.
    if (this.session !== null) return

    const charConfig = store.get(this.params.name)
    const resolvedCwd = charConfig.workDir
    const resumeId = charConfig.sessionId
    this.currentResponseText = ''
    this.session = new ClaudeSession()

    // Forward all session events to the popover renderer
    const send = (channel: string, ...args: unknown[]) => {
      const wc = this.popoverWin?.webContents
      if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
    }

    this.session.on('sessionId', id => {
      store.set(this.params.name, { ...store.get(this.params.name), sessionId: id })
    })
    this.session.on('text', chunk => {
      this.currentResponseText += chunk
      if (this.thinkingActive || this.toolBubbleActive) {
        if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = null }
        this.thinkingActive = false
        this.toolBubbleActive = false
        this.hideBubble()
      }
      send(IPC.SESSION_TEXT, chunk)
    })
    this.session.on('toolUse', (name, input) => {
      if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = null }
      this.thinkingActive = false
      this.toolBubbleActive = true
      const label = name.length > 10 ? name.slice(0, 9) + '…' : name
      this.showBubble(`[${label}…]`)
      send(IPC.SESSION_TOOL_USE, name, input)
    })
    this.session.on('toolResult', (summary, isError) => send(IPC.SESSION_TOOL_RESULT, summary, isError))
    this.session.on('turnComplete', () => {
      if (this.pendingUserMessage !== null) {
        const cfg = store.get(this.params.name)
        const updated = [...(cfg.history ?? []),
          { role: 'user' as const, text: this.pendingUserMessage },
          { role: 'assistant' as const, text: this.currentResponseText.trim() },
        ].slice(-20) // keep last 10 pairs
        store.set(this.params.name, { ...cfg, history: updated })
        this.pendingUserMessage = null
        this.currentResponseText = ''
      }
      this.stopThinking()
      this.showCompletion()
      send(IPC.SESSION_TURN_COMPLETE)
    })
    this.session.on('ready', () => {
      send(IPC.SESSION_READY)
      send(IPC.SESSION_CWD, resolvedCwd)
    })
    this.session.on('error', msg => {
      this.stopThinking()
      this.hideBubble()
      send(IPC.SESSION_ERROR, msg)
      this.session = null
      this.currentResponseText = ''
    })
    this.session.on('exit', () => {
      this.stopThinking()
      this.hideBubble()
      send(IPC.SESSION_EXIT)
      this.session = null
      this.currentResponseText = ''
    })

    await this.session.start(resolvedCwd, resumeId)
  }

  sendToSession(text: string): void {
    this.pendingUserMessage = text
    if (this.session?.isRunning) {
      this.startThinking()
      this.session.send(text)
      return
    }
    void this.startSession().then(() => {
      if (this.session) {
        this.startThinking()
        this.session.send(text)
      }
    })
  }

  terminateSession(): void {
    this.stopThinking()
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null }
    this.hideBubble()
    this.session?.terminate()
    this.session = null
  }

  setWorkDir(dirPath: string): void {
    store.set(this.params.name, { ...store.get(this.params.name), workDir: dirPath, sessionId: undefined, history: [] })
    this.terminateSession()
    const folderName = dirPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? dirPath
    this.showBubble(`📁 ${folderName}`, 'complete')
    setTimeout(() => this.hideBubble(), 2500)
    log.info(`WorkDir: ${this.params.name} → ${dirPath}`)
  }

  toggleVisibility(): void {
    this.visible = !this.visible
    if (this.visible) {
      this.win.show()
    } else {
      this.win.hide()
    }
    log.info(`WalkerCharacter(${this.params.name}) visibility → ${this.visible}`)
  }

  applySize(size: CharacterSize): void {
    const charH = SIZE_HEIGHT[size] ?? SIZE_HEIGHT.large
    const { winW, winH } = charToWindow(charH)
    this.win.setSize(winW, winH)
    log.info(`WalkerCharacter(${this.params.name}) size → ${size} (${winW}x${winH})`)
  }

  destroy(): void {
    this.terminateSession()
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null }
    this.popoverWin?.destroy()
    this.popoverWin = null
    this.win.destroy()
  }

  // ---- private helpers ----

  applyTheme(theme: ThemeName): void {
    const wc = this.popoverWin?.webContents
    if (wc && !wc.isDestroyed()) wc.send(IPC.THEME_APPLY, theme)
  }

  private createPopover(): BrowserWindow {
    const char = this.params.name
    const provider = store.get(char).provider
    const theme = store.get('theme')

    const win = new BrowserWindow({
      width: POPOVER_W,
      height: POPOVER_H,
      frame: false,
      transparent: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/popover.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    // Below screen-saver (walker) level
    win.setAlwaysOnTop(true, 'floating')

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}/popover/index.html?char=${char}&provider=${provider}&theme=${theme}`
      )
    } else {
      win.loadFile(join(__dirname, '../renderer/popover/index.html'), {
        query: { char, provider, theme },
      })
    }

    log.info(`WalkerCharacter(${char}) popover created`)
    return win
  }

  private positionPopover(): void {
    if (!this.popoverWin) return

    const walkerBounds = this.win.getBounds()
    const display = screen.getDisplayMatching(walkerBounds)
    const { x: areaX, y: areaY, width: areaW, height: areaH } = display.workArea

    // Center horizontally over walker, sit above the character (not the bubble)
    let px = walkerBounds.x + Math.round(walkerBounds.width / 2) - Math.round(POPOVER_W / 2)
    let py = walkerBounds.y + BUBBLE_H - POPOVER_H - 8

    // Clamp to work area
    px = Math.max(areaX, Math.min(px, areaX + areaW - POPOVER_W))
    py = Math.max(areaY, Math.min(py, areaY + areaH - POPOVER_H))

    this.popoverWin.setBounds({ x: px, y: py, width: POPOVER_W, height: POPOVER_H })
  }

  private startWalk(): void {
    const walkFraction = randomInRange(this.params.walkAmountRange)
    // Walk duration = accelStart → walkStop, converted to ms
    this.walkDurationMs = (this.params.walkStop - this.params.accelStart) * 1000

    this.walkStartProgress = this.positionProgress
    const tentative = this.positionProgress + this.direction * walkFraction
    this.walkEndProgress = Math.max(0, Math.min(1, tentative))

    this.state = 'walking'
    this.walkTimer = 0
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.WALKER_WALKING, true, this.params.accelStart)
    log.debug(
      `WalkerCharacter(${this.params.name}) walk start ` +
        `progress=${this.positionProgress.toFixed(3)} → ${this.walkEndProgress.toFixed(3)} ` +
        `dir=${this.direction}`
    )
  }

  private syncFlip(): void {
    const flipped = this.direction === -1
    if (flipped !== this.lastSentFlipped) {
      this.win.webContents.send(IPC.WALKER_FLIP, flipped)
      this.lastSentFlipped = flipped
    }
  }

  private applyBounds(): void {
    if (!this.taskbar) return
    const { rect, edge } = this.taskbar

    const size = store.get(`${this.params.name}.size`, 'large') as string
    const charH = SIZE_HEIGHT[size] ?? SIZE_HEIGHT.large
    const { winW, winH } = charToWindow(charH)

    // positionProgress (0..1) maps to horizontal offset within taskbar
    const maxOffset = Math.max(0, rect.w - winW)
    const x = rect.x + Math.round(this.positionProgress * maxOffset)

    // Window extends BUBBLE_H above the character area, so shift y up by BUBBLE_H
    // to keep character feet at the same screen position as before.
    let y: number
    switch (edge) {
      case 'bottom':
        y = rect.y - charH + this.params.yOffset - BUBBLE_H
        break
      case 'top':
        y = rect.y + rect.h - this.params.yOffset - BUBBLE_H
        break
      case 'left':
        y = Math.round(screen.getPrimaryDisplay().bounds.height / 2 - charH / 2) - BUBBLE_H
        break
      case 'right':
        y = Math.round(screen.getPrimaryDisplay().bounds.height / 2 - charH / 2) - BUBBLE_H
        break
    }

    this.win.setBounds({ x, y: y!, width: winW, height: winH })
  }
}
