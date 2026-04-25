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
  private bruce: WalkerCharacter | null = null
  private jazz: WalkerCharacter | null = null
  private tray: AppTray | null = null
  private readonly taskbar: TaskbarMonitor
  private readonly fullscreen: FullscreenMonitor
  private readonly updater: AppUpdater
  private readonly tick: TickLoop
  private lastTickTime = 0
  private lastZOrder: 'bruce-front' | 'jazz-front' | 'none' = 'none'
  private hiddenForFullscreen = false
  private lastActiveChar: 'bruce' | 'jazz' = 'bruce'

  constructor() {
    this.taskbar = new TaskbarMonitor()
    this.fullscreen = new FullscreenMonitor()
    this.updater = new AppUpdater()
    this.tick = new TickLoop()
  }

  init(): void {
    this.logDisplayInfo()

    this.bruce = new WalkerCharacter('bruce')
    this.jazz = new WalkerCharacter('jazz')

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
      this.bruce?.updateTaskbar(geometry)
      this.jazz?.updateTaskbar(geometry)
    })
    this.taskbar.start()

    this.fullscreen.start(isFullscreen => this.onFullscreenChange(isFullscreen))

    const tickCallback = (now: number): void => {
      const dt = this.lastTickTime === 0 ? 16 : now - this.lastTickTime
      this.lastTickTime = now
      const clampedDt = Math.min(dt, 100)
      this.bruce?.tick(clampedDt)
      this.jazz?.tick(clampedDt)
      this.bruce?.updateClickState()
      this.jazz?.updateClickState()
      this.syncZOrder()
    }

    this.tick.add(tickCallback)
    this.tick.start()

    if (!app.isPackaged) {
      this.bruce.win.webContents.openDevTools({ mode: 'detach' })
    }

    this.updater.start()

    const registered = globalShortcut.register('Ctrl+Shift+Space', () => {
      const char = this.lastActiveChar === 'bruce' ? this.bruce : this.jazz
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
          this.bruce?.hideBubble()
          this.jazz?.hideBubble()
          log.info('Onboarding complete')
        }
        this.lastActiveChar = char === this.bruce ? 'bruce' : 'jazz'
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
    if (sender === this.bruce?.win.webContents) return this.bruce
    if (sender === this.jazz?.win.webContents) return this.jazz
    return null
  }

  private findCharByPopover(sender: Electron.WebContents): WalkerCharacter | null {
    if (sender === this.bruce?.popover?.webContents) return this.bruce
    if (sender === this.jazz?.popover?.webContents) return this.jazz
    return null
  }

  private syncZOrder(): void {
    if (!this.bruce?.isVisible || !this.jazz?.isVisible) return

    const bruceBounds = this.bruce.win.getBounds()
    const jazzBounds = this.jazz.win.getBounds()

    const overlapping =
      bruceBounds.x < jazzBounds.x + jazzBounds.width &&
      bruceBounds.x + bruceBounds.width > jazzBounds.x

    if (!overlapping) {
      if (this.lastZOrder !== 'none') this.lastZOrder = 'none'
      return
    }

    // Right character sits in front of left character
    const desired: 'bruce-front' | 'jazz-front' =
      bruceBounds.x >= jazzBounds.x ? 'bruce-front' : 'jazz-front'

    if (desired === this.lastZOrder) return
    this.lastZOrder = desired

    if (desired === 'bruce-front') {
      this.jazz.win.moveTop()
      this.bruce.win.moveTop()
    } else {
      this.bruce.win.moveTop()
      this.jazz.win.moveTop()
    }
  }

  private onFullscreenChange(isFullscreen: boolean): void {
    if (isFullscreen && !this.hiddenForFullscreen) {
      this.hiddenForFullscreen = true
      this.bruce?.win.hide()
      this.jazz?.win.hide()
      this.bruce?.hidePopover()
      this.jazz?.hidePopover()
    } else if (!isFullscreen && this.hiddenForFullscreen) {
      this.hiddenForFullscreen = false
      if (this.bruce?.isVisible) this.bruce.win.show()
      if (this.jazz?.isVisible) this.jazz.win.show()
    }
  }

  private onWorkDirChange(char: CharacterName, dir: string): void {
    const walker = char === 'bruce' ? this.bruce : this.jazz
    walker?.terminateSession()
    log.info(`WorkDir: ${char} → ${dir}`)
  }

  private onProviderChange(char: CharacterName, provider: AgentProvider): void {
    log.info(`Provider: ${char} → ${provider}`)
    // Session switching wired in Phase 6
  }

  private onSizeChange(char: CharacterName, size: CharacterSize): void {
    const walker = char === 'bruce' ? this.bruce : this.jazz
    walker?.applySize(size)
  }

  private onHide(char: CharacterName): void {
    const walker = char === 'bruce' ? this.bruce : this.jazz
    walker?.toggleVisibility()
  }

  private onThemeChange(theme: ThemeName): void {
    store.set('theme', theme)
    this.bruce?.applyTheme(theme)
    this.jazz?.applyTheme(theme)
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
    this.bruce?.destroy()
    this.jazz?.destroy()
    this.bruce = null
    this.jazz = null
  }
}
