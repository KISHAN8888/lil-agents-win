import { app, screen, ipcMain, globalShortcut, powerMonitor, dialog } from 'electron'
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
  private saul: WalkerCharacter | null = null
  private kim: WalkerCharacter | null = null
  private tray: AppTray | null = null
  private readonly taskbar: TaskbarMonitor
  private readonly fullscreen: FullscreenMonitor
  private readonly updater: AppUpdater
  private readonly tick: TickLoop
  private readonly worker: WorkerProcess
  private lastTickTime = 0
  private lastZOrder: 'saul-front' | 'kim-front' | 'none' = 'none'
  private hiddenForFullscreen = false
  private lastActiveChar: 'saul' | 'kim' = 'saul'

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
        this.saul?.onContextResult(event.context)
      }
    })

    this.saul = new WalkerCharacter('saul')
    this.kim = new WalkerCharacter('kim')

    this.saul.setWorkerHandler((cmd) => this.worker.send(cmd))
    this.kim.setWorkerHandler((cmd) => this.worker.send(cmd))

    this.saul.win.on('ingest-note' as any, ((text: string) => {
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
    }) as any)

    this.kim.win.on('ingest-note' as any, ((text: string) => {
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
    }) as any)

    this.saul.win.on('ingest-url' as any, ((url: string) => {
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
    }) as any)

    this.kim.win.on('ingest-url' as any, ((url: string) => {
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
    }) as any)

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
      this.saul?.updateTaskbar(geometry)
      this.kim?.updateTaskbar(geometry)
      this.updateWalkBoundary()
    })
    this.taskbar.start()

    this.fullscreen.start(isFullscreen => this.onFullscreenChange(isFullscreen))

    const tickCallback = (now: number): void => {
      const dt = this.lastTickTime === 0 ? 16 : now - this.lastTickTime
      this.lastTickTime = now
      const clampedDt = Math.min(dt, 100)
      this.saul?.tick(clampedDt)
      this.kim?.tick(clampedDt)
      this.saul?.updateClickState()
      this.kim?.updateClickState()
      this.syncZOrder()
    }

    this.tick.add(tickCallback)
    this.tick.start()

    if (!app.isPackaged) {
      this.saul.win.webContents.openDevTools({ mode: 'detach' })
    }

    this.updater.start()

    const registered = globalShortcut.register('Ctrl+Shift+Space', () => {
      const char = this.lastActiveChar === 'saul' ? this.saul : this.kim
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
          this.saul?.hideBubble()
          this.kim?.hideBubble()
          log.info('Onboarding complete')
        }
        this.lastActiveChar = char === this.saul ? 'saul' : 'kim'
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

    ipcMain.handle(IPC.SELECT_FILE, async (event) => {
      const char = this.findCharByPopover(event.sender)
      if (char) char.setPreventHideOnBlur(true)
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select file to ingest',
        properties: ['openFile'],
      })
      if (char) char.setPreventHideOnBlur(false)
      if (canceled) return null
      return filePaths[0]
    })

    ipcMain.on(IPC.WALKER_INGEST, (event, filePath: string, caption?: string) => {
      const char = this.findCharByWalker(event.sender) || this.findCharByPopover(event.sender)
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
    if (sender === this.saul?.win.webContents) return this.saul
    if (sender === this.kim?.win.webContents) return this.kim
    return null
  }

  private findCharByPopover(sender: Electron.WebContents): WalkerCharacter | null {
    if (sender === this.saul?.popover?.webContents) return this.saul
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
    if (!this.saul?.isVisible || !this.kim?.isVisible) return

    const saulBounds = this.saul.win.getBounds()
    const kimBounds = this.kim.win.getBounds()

    const overlapping =
      saulBounds.x < kimBounds.x + kimBounds.width &&
      saulBounds.x + saulBounds.width > kimBounds.x

    if (!overlapping) {
      if (this.lastZOrder !== 'none') this.lastZOrder = 'none'
      return
    }

    // Right character sits in front of left character
    const desired: 'saul-front' | 'kim-front' =
      saulBounds.x >= kimBounds.x ? 'saul-front' : 'kim-front'

    if (desired === this.lastZOrder) return
    this.lastZOrder = desired

    if (desired === 'saul-front') {
      this.kim.win.moveTop()
      this.saul.win.moveTop()
    } else {
      this.saul.win.moveTop()
      this.kim.win.moveTop()
    }
  }

  private onFullscreenChange(isFullscreen: boolean): void {
    if (isFullscreen && !this.hiddenForFullscreen) {
      this.hiddenForFullscreen = true
      this.saul?.win.hide()
      this.kim?.win.hide()
      this.saul?.hidePopover()
      this.kim?.hidePopover()
    } else if (!isFullscreen && this.hiddenForFullscreen) {
      this.hiddenForFullscreen = false
      if (this.saul?.isVisible) this.saul.win.show()
      if (this.kim?.isVisible) this.kim.win.show()
    }
  }

  private onWorkDirChange(char: CharacterName, dir: string): void {
    const walker = char === 'saul' ? this.saul : this.kim
    walker?.terminateSession()
    log.info(`WorkDir: ${char} → ${dir}`)
  }

  private onProviderChange(char: CharacterName, provider: AgentProvider): void {
    const walker = char === 'saul' ? this.saul : this.kim
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
    // Terminate Saul's session so it restarts with the new CWD
    this.saul?.terminateSession()
    
    // Clear ALL sessions for Saul so it doesn't try to resume an obsolete session ID
    // either in the default directory or the vault directory.
    const saulCfg = store.get('saul')
    if (saulCfg) {
      store.set('saul', { ...saulCfg, sessions: {}, vaultSessions: {} })
    }

    this.saul?.showBubble(enabled ? 'Vault chat' : 'Free chat', 'complete')
    setTimeout(() => this.saul?.hideBubble(), 2500)
    log.info(`Vault mode → ${enabled}`)
  }

  private onSizeChange(char: CharacterName, size: CharacterSize): void {
    const walker = char === 'saul' ? this.saul : this.kim
    walker?.applySize(size)
  }

  private onHide(char: CharacterName): void {
    const walker = char === 'saul' ? this.saul : this.kim
    walker?.toggleVisibility()
  }

  private onThemeChange(theme: ThemeName): void {
    store.set('theme', theme)
    this.saul?.applyTheme(theme)
    this.kim?.applyTheme(theme)
    log.info(`Theme → ${theme}`)
  }

  private updateWalkBoundary(): void {
    if (!this.saul || !this.kim) return
    const kimBounds = this.kim.win.getBounds()
    const saulBounds = this.saul.win.getBounds()
    const geometry = this.taskbar.geometry
    if (!geometry) return
    const { rect } = geometry
    const gap = 8
    const maxSaulRight = kimBounds.x - gap
    const maxOffset = Math.max(1, rect.w - saulBounds.width)
    const maxProgress = (maxSaulRight - rect.x - saulBounds.width) / maxOffset
    this.saul.setMaxProgress(maxProgress)
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
    this.saul?.destroy()
    this.kim?.destroy()
    this.saul = null
    this.kim = null
  }
}
