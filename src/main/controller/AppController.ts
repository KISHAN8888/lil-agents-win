import { app, screen, ipcMain, globalShortcut, powerMonitor } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { TaskbarMonitor } from '../platform/taskbar'
import { FullscreenMonitor } from '../platform/fullscreen'
import { AppTray } from '../platform/tray'
import { AppUpdater } from '../updater'
import { TickLoop } from './tickLoop'
import { WalkerCharacter } from './WalkerCharacter'
import { WorkerProcess } from './WorkerProcess'
import { IPC } from '../ipc/channels'
import store from '../store'
import log from '../logger'
import type { CharacterName, AgentProvider, CharacterSize, ThemeName } from '../../shared/types'

export class AppController {
  private tuco: WalkerCharacter | null = null
  private kim: WalkerCharacter | null = null
  private tray: AppTray | null = null
  private readonly taskbar: TaskbarMonitor
  private readonly fullscreen: FullscreenMonitor
  private readonly updater: AppUpdater
  private readonly tick: TickLoop
  private readonly worker: WorkerProcess
  private lastTickTime = 0
  private lastZOrder: 'tuco-front' | 'kim-front' | 'none' = 'none'
  private hiddenForFullscreen = false
  private lastActiveChar: 'tuco' | 'kim' = 'tuco'

  constructor() {
    this.taskbar = new TaskbarMonitor()
    this.fullscreen = new FullscreenMonitor()
    this.updater = new AppUpdater()
    this.tick = new TickLoop()
    this.worker = new WorkerProcess()
    
    powerMonitor.on('resume', () => this.checkCompileScheduler())
  }

  init(): void {
    this.logDisplayInfo()

    // Initialize vault path if not set
    if (!store.get('vaultPath')) {
      const defaultVault = join(app.getPath('home'), 'lil-agents-vault')
      store.set('vaultPath', defaultVault)
      log.info(`Initializing default vault path: ${defaultVault}`)
    }

    this.worker.start()
    this.worker.send({ cmd: 'status' })
    const vaultPath = store.get('vaultPath')
    if (vaultPath) {
      const kimConfig = store.get('kim')
      this.worker.send({ cmd: 'init_vault', path: vaultPath, provider: kimConfig.provider })
      // Initial check after 5s
      setTimeout(() => this.checkCompileScheduler(), 5000)
    }

    this.worker.on('event', (event) => {
      if (event.event === 'task_completed') {
        this.kim?.showBubble('done!', 'complete')
        setTimeout(() => this.kim?.hideBubble(), 3000)
      } else if (event.event === 'task_failed') {
        this.kim?.showBubble('error', 'default')
        log.error(`Ingest task failed: ${event.error}`)
        setTimeout(() => this.kim?.hideBubble(), 3000)
      } else if (event.event === 'context_result') {
        this.tuco?.onContextResult(event.context)
      }
    })

    this.tuco = new WalkerCharacter('tuco')
    this.kim = new WalkerCharacter('kim')

    this.tuco.setWorkerHandler((cmd) => this.worker.send(cmd))
    this.kim.setWorkerHandler((cmd) => this.worker.send(cmd))

    this.tuco.win.on('ingest-note' as any, (text: string) => {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.kim?.showBubble('ingesting...')
        this.worker.send({
          cmd: 'ingest',
          kind: 'text',
          text: text,
          vault_path: vaultPath
        })
      }
    })

    this.kim.win.on('ingest-note' as any, (text: string) => {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.kim?.showBubble('ingesting...')
        this.worker.send({
          cmd: 'ingest',
          kind: 'text',
          text: text,
          vault_path: vaultPath
        })
      }
    })

    this.tuco.win.on('ingest-url' as any, (url: string) => {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.kim?.showBubble('ingesting...')
        this.worker.send({
          cmd: 'ingest',
          kind: 'url',
          path: url,
          vault_path: vaultPath
        })
      }
    })

    this.kim.win.on('ingest-url' as any, (url: string) => {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.kim?.showBubble('ingesting...')
        this.worker.send({
          cmd: 'ingest',
          kind: 'url',
          path: url,
          vault_path: vaultPath
        })
      }
    })

    this.tray = new AppTray({
      onProviderChange: (char, provider) => this.onProviderChange(char, provider),
      onSizeChange: (char, size) => this.onSizeChange(char, size),
      onWorkDirChange: (char, dir) => this.onWorkDirChange(char, dir),
      onHide: (char) => this.onHide(char),
      onThemeChange: (theme) => this.onThemeChange(theme),
      onVaultModeChange: (enabled) => this.onVaultModeChange(enabled),
      onCheckUpdates: () => this.updater.checkNow(),
      onQuit: () => {
        this.destroy()
        app.quit()
      },
    })

    this.setupIpc()

    this.taskbar.on('change', geometry => {
      this.tuco?.updateTaskbar(geometry)
      this.kim?.updateTaskbar(geometry)
    })
    this.taskbar.start()

    this.fullscreen.start(isFullscreen => this.onFullscreenChange(isFullscreen))

    const tickCallback = (now: number): void => {
      const dt = this.lastTickTime === 0 ? 16 : now - this.lastTickTime
      this.lastTickTime = now
      const clampedDt = Math.min(dt, 100)
      this.tuco?.tick(clampedDt)
      this.kim?.tick(clampedDt)
      this.tuco?.updateClickState()
      this.kim?.updateClickState()
      this.syncZOrder()
    }

    this.tick.add(tickCallback)
    this.tick.start()

    if (!app.isPackaged) {
      this.tuco.win.webContents.openDevTools({ mode: 'detach' })
    }

    this.updater.start()

    const registered = globalShortcut.register('Ctrl+Shift+Space', () => {
      const char = this.lastActiveChar === 'tuco' ? this.tuco : this.kim
      char?.togglePopover()
    })
    if (!registered) log.warn('Global shortcut Ctrl+Shift+Space could not be registered')
  }

  private setupIpc(): void {
    ipcMain.on(IPC.WALKER_READY, event => {
      this.findCharByWalker(event.sender)?.onWalkerReady()
    })

    ipcMain.on(IPC.WALKER_CLICK, event => {
      const char = this.findCharByWalker(event.sender)
      if (char) {
        if (!store.get('hasCompletedOnboarding')) {
          store.set('hasCompletedOnboarding', true)
          this.tuco?.hideBubble()
          this.kim?.hideBubble()
          log.info('Onboarding complete')
        }
        this.lastActiveChar = char === this.tuco ? 'tuco' : 'kim'
        char.togglePopover()
      }
    })

    ipcMain.on(IPC.POPOVER_READY, event => {
      this.findCharByPopover(event.sender)?.onRendererReady()
    })

    ipcMain.on(IPC.POPOVER_CLOSE, event => {
      this.findCharByPopover(event.sender)?.hidePopover()
    })

    ipcMain.on(IPC.SESSION_SEND, (event, text: string) => {
      this.findCharByPopover(event.sender)?.sendToSession(text)
    })

    ipcMain.on(IPC.SESSION_TERMINATE, event => {
      this.findCharByPopover(event.sender)?.terminateSession()
    })

    ipcMain.on(IPC.WALKER_SET_WORKDIR, (event, dirPath: string) => {
      const char = this.findCharByWalker(event.sender)
      if (char) {
        char.setWorkDir(dirPath)
        this.tray?.buildMenu()
      }
    })

    ipcMain.on(IPC.WALKER_INGEST, (event, filePath: string, caption?: string) => {
      const char = this.findCharByWalker(event.sender)
      if (char) {
        const vaultPath = store.get('vaultPath')
        if (!vaultPath) {
          log.error('No vault path configured')
          return
        }
        char.showBubble('ingesting...')
        this.worker.send({
          cmd: 'ingest',
          kind: 'file',
          path: filePath,
          caption: caption,
          vault_path: vaultPath
        })
      }
    })

    ipcMain.on(IPC.WALKER_MODAL_OPEN, (event, isOpen: boolean) => {
      const char = this.findCharByWalker(event.sender)
      if (char) {
        char.setModalOpen(isOpen)
      }
    })
  }

  private findCharByWalker(sender: Electron.WebContents): WalkerCharacter | null {
    if (sender === this.tuco?.win.webContents) return this.tuco
    if (sender === this.kim?.win.webContents) return this.kim
    return null
  }

  private findCharByPopover(sender: Electron.WebContents): WalkerCharacter | null {
    if (sender === this.tuco?.popover?.webContents) return this.tuco
    if (sender === this.kim?.popover?.webContents) return this.kim
    return null
  }

  private checkCompileScheduler(): void {
    const vaultPath = store.get('vaultPath')
    if (!vaultPath) return

    const statePath = join(vaultPath, '.sage', 'state.json')
    let lastCompileAt = 0
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'))
        lastCompileAt = state.lastCompileAt || 0
      } catch (e) {
        log.error(`Failed to read vault state: ${e}`)
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const dayInSec = 24 * 60 * 60
    if (now - lastCompileAt > dayInSec) {
      log.info('Scheduled stitch pass triggered')
      this.worker.send({ cmd: 'compile_now', vault_path: vaultPath })
    }
  }

  private syncZOrder(): void {
    if (!this.tuco?.isVisible || !this.kim?.isVisible) return

    const tucoBounds = this.tuco.win.getBounds()
    const kimBounds = this.kim.win.getBounds()

    const overlapping =
      tucoBounds.x < kimBounds.x + kimBounds.width &&
      tucoBounds.x + tucoBounds.width > kimBounds.x

    if (!overlapping) {
      if (this.lastZOrder !== 'none') this.lastZOrder = 'none'
      return
    }

    // Right character sits in front of left character
    const desired: 'tuco-front' | 'kim-front' =
      tucoBounds.x >= kimBounds.x ? 'tuco-front' : 'kim-front'

    if (desired === this.lastZOrder) return
    this.lastZOrder = desired

    if (desired === 'tuco-front') {
      this.kim.win.moveTop()
      this.tuco.win.moveTop()
    } else {
      this.tuco.win.moveTop()
      this.kim.win.moveTop()
    }
  }

  private onFullscreenChange(isFullscreen: boolean): void {
    if (isFullscreen && !this.hiddenForFullscreen) {
      this.hiddenForFullscreen = true
      this.tuco?.win.hide()
      this.kim?.win.hide()
      this.tuco?.hidePopover()
      this.kim?.hidePopover()
    } else if (!isFullscreen && this.hiddenForFullscreen) {
      this.hiddenForFullscreen = false
      if (this.tuco?.isVisible) this.tuco.win.show()
      if (this.kim?.isVisible) this.kim.win.show()
    }
  }

  private onWorkDirChange(char: CharacterName, dir: string): void {
    const walker = char === 'tuco' ? this.tuco : this.kim
    walker?.terminateSession()
    log.info(`WorkDir: ${char} → ${dir}`)
  }

  private onProviderChange(char: CharacterName, provider: AgentProvider): void {
    const walker = char === 'tuco' ? this.tuco : this.kim
    walker?.applyProvider(provider)

    if (char === 'kim') {
      const vaultPath = store.get('vaultPath')
      if (vaultPath) {
        this.worker.send({ cmd: 'update_config', vault_path: vaultPath, config: { llm_provider: provider } })
      }
    }

    log.info(`Provider: ${char} → ${provider}`)
  }

  private onVaultModeChange(enabled: boolean): void {
    // Terminate Tuco's session so it restarts with the new CWD
    this.tuco?.terminateSession()
    
    // Clear ALL sessions for Tuco so it doesn't try to resume an obsolete session ID
    // either in the default directory or the vault directory.
    const tucoCfg = store.get('tuco')
    if (tucoCfg) {
      store.set('tuco', { ...tucoCfg, sessions: {}, vaultSessions: {} })
    }

    this.tuco?.showBubble(enabled ? 'Vault chat' : 'Free chat', 'complete')
    setTimeout(() => this.tuco?.hideBubble(), 2500)
    log.info(`Vault mode → ${enabled}`)
  }

  private onSizeChange(char: CharacterName, size: CharacterSize): void {
    const walker = char === 'tuco' ? this.tuco : this.kim
    walker?.applySize(size)
  }

  private onHide(char: CharacterName): void {
    const walker = char === 'tuco' ? this.tuco : this.kim
    walker?.toggleVisibility()
  }

  private onThemeChange(theme: ThemeName): void {
    store.set('theme', theme)
    this.tuco?.applyTheme(theme)
    this.kim?.applyTheme(theme)
    log.info(`Theme → ${theme}`)
  }

  private logDisplayInfo(): void {
    for (const d of screen.getAllDisplays()) {
      log.info(
        `Display id=${d.id} bounds=${JSON.stringify(d.bounds)} ` +
          `scaleFactor=${d.scaleFactor} ` +
          `primary=${d.id === screen.getPrimaryDisplay().id}`
      )
    }
  }

  destroy(): void {
    globalShortcut.unregisterAll()
    this.worker.stop()
    this.updater.stop()
    this.fullscreen.stop()
    this.tick.stop()
    this.taskbar.stop()
    this.tray?.destroy()
    this.tuco?.destroy()
    this.kim?.destroy()
    this.tuco = null
    this.kim = null
  }
}
