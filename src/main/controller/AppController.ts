import { app, screen, ipcMain, globalShortcut } from 'electron'
import { TaskbarMonitor } from '../platform/taskbar'
import { FullscreenMonitor } from '../platform/fullscreen'
import { AppTray } from '../platform/tray'
import { AppUpdater } from '../updater'
import { TickLoop } from './tickLoop'
import { WalkerCharacter } from './WalkerCharacter'
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
  private lastTickTime = 0
  private lastZOrder: 'tuco-front' | 'kim-front' | 'none' = 'none'
  private hiddenForFullscreen = false
  private lastActiveChar: 'tuco' | 'kim' = 'tuco'

  constructor() {
    this.taskbar = new TaskbarMonitor()
    this.fullscreen = new FullscreenMonitor()
    this.updater = new AppUpdater()
    this.tick = new TickLoop()
  }

  init(): void {
    this.logDisplayInfo()

    this.tuco = new WalkerCharacter('tuco')
    this.kim = new WalkerCharacter('kim')

    this.tray = new AppTray({
      onProviderChange: (char, provider) => this.onProviderChange(char, provider),
      onSizeChange: (char, size) => this.onSizeChange(char, size),
      onWorkDirChange: (char, dir) => this.onWorkDirChange(char, dir),
      onHide: (char) => this.onHide(char),
      onThemeChange: (theme) => this.onThemeChange(theme),
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
    log.info(`Provider: ${char} → ${provider}`)
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
