import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import koffi from 'koffi'
import { IPC } from '../ipc/channels'
import { BaseSession } from '../sessions/AgentSession'
import { createSession } from '../sessions/SessionFactory'
import store from '../store'
import log from '../logger'
import type { TaskbarGeometry, CharacterName, CharacterSize, ThemeName, AgentProvider } from '../../shared/types'

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

const TUCO_PARAMS: CharacterParams = {
  name: 'tuco',
  videoFile: 'Walking monkey.webm',
  videoDurationSec: 1.0,
  accelStart: 0,
  fullSpeedStart: 0,
  decelStart: 8.0,
  walkStop: 8.0,
  walkAmountRange: [0.2, 0.4],
  yOffset: 25,
}

const KIM_PARAMS: CharacterParams = {
  name: 'kim',
  videoFile: 'walk.webm',
  videoDurationSec: 1.0,
  accelStart: 0,
  fullSpeedStart: 0,
  decelStart: 8.0,
  walkStop: 8.0,
  walkAmountRange: [0.2, 0.4],
  yOffset: 25,
}

export const CHARACTER_PARAMS: Record<CharacterName, CharacterParams> = {
  tuco: TUCO_PARAMS,
  kim: KIM_PARAMS,
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

function charToWindow(charH: number, charName: CharacterName): { winW: number; winH: number } {
  const winW = charH
  return { winW, winH: charH + BUBBLE_H }
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
  private session: BaseSession | null = null
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
  private modalOpen = false

  // idle
  private pauseMs = 500 + Math.random() * 1500 // initial random pause

  // walking
  private walkStartProgress = 0
  private walkEndProgress = 0
  private walkTimer = 0
  private walkDurationMs = 0

  private taskbar: TaskbarGeometry | null = null
  
  // Phase 11
  private onWorkerRequest: ((cmd: any) => void) | null = null
  private contextResolver: ((context: string) => void) | null = null

  constructor(name: CharacterName) {
    this.params = CHARACTER_PARAMS[name]
    const size = store.get(`${name}.size`, 'large') as string
    const charH = SIZE_HEIGHT[size] ?? SIZE_HEIGHT.large
    const { winW, winH } = charToWindow(charH, name)

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

    GetAsyncKeyState(VK_LBUTTON)
    setTimeout(() => { this.clickReady = true }, 500)
  }

  setWorkerHandler(handler: (cmd: any) => void): void {
    this.onWorkerRequest = handler
  }

  onContextResult(context: string): void {
    if (this.contextResolver) {
      this.contextResolver(context)
      this.contextResolver = null
    }
  }

  get popover(): BrowserWindow | null {
    return this.popoverWin
  }

  updateTaskbar(geometry: TaskbarGeometry): void {
    this.taskbar = geometry
    this.applyBounds()
  }

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
        }
      }
    }

    this.syncFlip()
    this.applyBounds()
  }

  get isVisible(): boolean {
    return this.visible
  }

  setModalOpen(isOpen: boolean): void {
    this.modalOpen = isOpen
  }

  updateClickState(): void {
    if (!this.clickReady || this.modalOpen) return
    const cursor = screen.getCursorScreenPoint()
    const b = this.win.getBounds()

    const inside =
      cursor.x >= b.x && cursor.x < b.x + b.width &&
      cursor.y >= b.y + BUBBLE_H && cursor.y < b.y + b.height

    if (inside !== this.clickable) {
      this.clickable = inside
      this.win.setIgnoreMouseEvents(!inside, { forward: true })
    }

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
      if (this.rendererReady && !this.session?.isRunning) {
        void this.startSession()
      }
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
    const cfg = store.get(this.params.name)
    const sessions = cfg.sessions ?? {}
    const history = sessions[cfg.provider]?.history ?? []
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

  async startSession(): Promise<void> {
    if (this.session !== null) return
    
    // Kim is the ingestion worker, she doesn't need an LLM session
    if (this.params.name === 'kim') return

    const charConfig = store.get(this.params.name)
    const provider = charConfig.provider
    let resolvedCwd = charConfig.workDir

    const isVaultMode = this.params.name === 'tuco' && store.get('vaultMode')
    if (isVaultMode) {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) resolvedCwd = join(vaultPath, 'wiki')
    }

    const sessionsObj = isVaultMode ? (charConfig.vaultSessions ?? {}) : (charConfig.sessions ?? {})
    const resumeId = sessionsObj[provider]?.sessionId
    this.currentResponseText = ''
    this.session = createSession(provider)

    const send = (channel: string, ...args: unknown[]) => {
      const wc = this.popoverWin?.webContents
      if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
    }

    this.session.on('sessionId', id => {
      const cfg = store.get(this.params.name)
      const currentProvider = cfg.provider
      if (isVaultMode) {
        const vs = { ...cfg.vaultSessions }
        vs[currentProvider] = { ...vs[currentProvider], sessionId: id, history: vs[currentProvider]?.history ?? [] }
        store.set(this.params.name, { ...cfg, vaultSessions: vs })
      } else {
        const s = { ...cfg.sessions }
        s[currentProvider] = { ...s[currentProvider], sessionId: id, history: s[currentProvider]?.history ?? [] }
        store.set(this.params.name, { ...cfg, sessions: s })
      }
    })
    this.session.on('text', chunk => {
      this.currentResponseText += chunk
      if (this.thinkingActive || this.toolBubbleActive) {
        this.stopThinking()
        this.hideBubble()
      }
      send(IPC.SESSION_TEXT, chunk)
    })
    this.session.on('toolUse', (name, input) => {
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
        const provider = cfg.provider
        const isVaultMode = this.params.name === 'tuco' && store.get('vaultMode')
        const sessionsObj = isVaultMode ? { ...cfg.vaultSessions } : { ...cfg.sessions }
        const providerSession = sessionsObj[provider] ?? { history: [] }
        const updatedHistory = [...(providerSession.history ?? []),
          { role: 'user' as const, text: this.pendingUserMessage },
          { role: 'assistant' as const, text: this.currentResponseText.trim() },
        ].slice(-20)
        
        sessionsObj[provider] = { ...providerSession, history: updatedHistory }
        if (isVaultMode) {
          store.set(this.params.name, { ...cfg, vaultSessions: sessionsObj })
        } else {
          store.set(this.params.name, { ...cfg, sessions: sessionsObj })
        }
        
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
      
      // Clear the invalid session ID
      const cfg = store.get(this.params.name)
      const provider = cfg.provider
      const isVaultMode = this.params.name === 'tuco' && store.get('vaultMode')
      const sessionsObj = isVaultMode ? { ...cfg.vaultSessions } : { ...cfg.sessions }
      if (sessionsObj[provider]) {
        delete sessionsObj[provider].sessionId
      }
      if (isVaultMode) {
        store.set(this.params.name, { ...cfg, vaultSessions: sessionsObj })
      } else {
        store.set(this.params.name, { ...cfg, sessions: sessionsObj })
      }
    })
    this.session.on('exit', () => {
      this.stopThinking()
      this.hideBubble()
      send(IPC.SESSION_EXIT)
      this.session = null
    })

    await this.session.start(resolvedCwd, resumeId)
  }

  async sendToSession(text: string): Promise<void> {
    if (this.params.name === 'tuco' && text.startsWith('/note ')) {
      const noteText = text.slice(6).trim()
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.win.emit('ingest-note', noteText)
        return
      }
    }

    if (this.params.name === 'kim') {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        let kind = 'text'
        let payload = text.trim()
        
        try {
          const url = new URL(payload)
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            kind = 'url'
          }
        } catch {
          // not a URL
        }

        if (kind === 'url') {
          this.win.emit('ingest-url', payload)
        } else {
          this.win.emit('ingest-note', payload)
        }
        
        // Echo to her history so it looks like it was processed
        this.pendingUserMessage = text
        this.currentResponseText = 'Added to vault.'
        const send = (channel: string, ...args: unknown[]) => {
          const wc = this.popoverWin?.webContents
          if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
        }
        
        // Immediately show the response in the UI
        send(IPC.SESSION_TEXT, this.currentResponseText)
        
        const cfg = store.get(this.params.name)
        const provider = cfg.provider
        const sessionsObj = { ...cfg.sessions }
        const providerSession = sessionsObj[provider] ?? { history: [] }
        const updatedHistory = [...(providerSession.history ?? []),
          { role: 'user' as const, text: this.pendingUserMessage },
          { role: 'assistant' as const, text: this.currentResponseText },
        ].slice(-20)
        
        sessionsObj[provider] = { ...providerSession, history: updatedHistory }
        store.set(this.params.name, { ...cfg, sessions: sessionsObj })
        
        this.pendingUserMessage = null
        this.currentResponseText = ''
        send(IPC.SESSION_TURN_COMPLETE)
        return
      }
    }

    let message = text
    if (this.params.name === 'tuco' && store.get('vaultMode')) {
      const vaultPath = store.get('vaultPath')
      if (vaultPath && this.onWorkerRequest) {
        this.startThinking()
        const context = await new Promise<string>(resolve => {
          this.contextResolver = resolve
          this.onWorkerRequest!({ cmd: 'get_context', vault_path: vaultPath, query: text })
          setTimeout(() => {
            if (this.contextResolver) {
              this.contextResolver('')
              this.contextResolver = null
            }
          }, 5000)
        })
        if (context) {
          message = `Context from personal wiki:\n---\n${context}\n---\n\nUser query: ${text}`
        }
      }
    }

    this.pendingUserMessage = text
    if (this.session?.isRunning) {
      if (!this.thinkingActive) this.startThinking()
      this.session.send(message)
      return
    }
    void this.startSession().then(() => {
      if (this.session) {
        if (!this.thinkingActive) this.startThinking()
        this.session.send(message)
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
    const cfg = store.get(this.params.name)
    store.set(this.params.name, { ...cfg, workDir: dirPath, sessions: {} })
    this.terminateSession()
    const folderName = dirPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? dirPath
    this.showBubble(`📁 ${folderName}`, 'complete')
    setTimeout(() => this.hideBubble(), 2500)
  }

  applyProvider(provider: AgentProvider): void {
    const cfg = store.get(this.params.name)
    if (cfg.provider === provider) return
    store.set(this.params.name, { ...cfg, provider })
    this.terminateSession()
    
    const wc = this.popoverWin?.webContents
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC.SESSION_PROVIDER, provider)
      const sessions = cfg.sessions ?? {}
      const history = sessions[provider]?.history ?? []
      wc.send(IPC.SESSION_HISTORY, history)
    }
  }

  toggleVisibility(): void {
    this.visible = !this.visible
    if (this.visible) {
      this.win.show()
    } else {
      this.win.hide()
    }
  }

  applySize(size: CharacterSize): void {
    const charH = SIZE_HEIGHT[size] ?? SIZE_HEIGHT.large
    const { winW, winH } = charToWindow(charH, this.params.name)
    this.win.setSize(winW, winH)
  }

  destroy(): void {
    this.terminateSession()
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null }
    this.popoverWin?.destroy()
    this.popoverWin = null
    this.win.destroy()
  }

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

    return win
  }

  private positionPopover(): void {
    if (!this.popoverWin) return
    const walkerBounds = this.win.getBounds()
    const display = screen.getDisplayMatching(walkerBounds)
    const { x: areaX, y: areaY, width: areaW, height: areaH } = display.workArea
    let px = walkerBounds.x + Math.round(walkerBounds.width / 2) - Math.round(POPOVER_W / 2)
    let py = walkerBounds.y + BUBBLE_H - POPOVER_H - 8
    px = Math.max(areaX, Math.min(px, areaX + areaW - POPOVER_W))
    py = Math.max(areaY, Math.min(py, areaY + areaH - POPOVER_H))
    this.popoverWin.setBounds({ x: px, y: py, width: POPOVER_W, height: POPOVER_H })
  }

  private startWalk(): void {
    const walkFraction = randomInRange(this.params.walkAmountRange)
    this.walkDurationMs = (this.params.walkStop - this.params.accelStart) * 1000
    this.walkStartProgress = this.positionProgress
    const tentative = this.positionProgress + this.direction * walkFraction
    this.walkEndProgress = Math.max(0, Math.min(1, tentative))
    this.state = 'walking'
    this.walkTimer = 0
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.WALKER_WALKING, true, this.params.accelStart)
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
    const { winW, winH } = charToWindow(charH, this.params.name)
    const maxOffset = Math.max(0, rect.w - winW)
    const x = rect.x + Math.round(this.positionProgress * maxOffset)
    let y: number
    switch (edge) {
      case 'bottom': y = rect.y - charH + this.params.yOffset - BUBBLE_H; break
      case 'top': y = rect.y + rect.h - this.params.yOffset - BUBBLE_H; break
      case 'left': y = Math.round(screen.getPrimaryDisplay().bounds.height / 2 - charH / 2) - BUBBLE_H; break
      case 'right': y = Math.round(screen.getPrimaryDisplay().bounds.height / 2 - charH / 2) - BUBBLE_H; break
    }
    this.win.setBounds({ x, y: y!, width: winW, height: winH })
  }
}