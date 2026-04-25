import { Tray, Menu, app, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import store from '../store'
import type { CharacterName, AgentProvider, CharacterSize, ThemeName } from '../../shared/types'
import log from '../logger'

export interface TrayHandlers {
  onProviderChange: (char: CharacterName, provider: AgentProvider) => void
  onSizeChange: (char: CharacterName, size: CharacterSize) => void
  onWorkDirChange: (char: CharacterName, dir: string) => void
  onHide: (char: CharacterName) => void
  onThemeChange: (theme: ThemeName) => void
  onCheckUpdates: () => void
  onQuit: () => void
}

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'openclaw']
const SIZES: CharacterSize[] = ['small', 'medium', 'large']
const THEMES: ThemeName[] = ['midnight', 'peach', 'cloud', 'moss']

export class AppTray {
  private tray: Tray
  private readonly handlers: TrayHandlers

  constructor(handlers: TrayHandlers) {
    this.handlers = handlers

    const assetBase = app.isPackaged ? process.resourcesPath : app.getAppPath()
    // menuicon-2x.png is 32x32; Electron picks the right resolution automatically
    const icon = nativeImage.createFromPath(join(assetBase, 'assets', 'menuicon.png'))
    icon.addRepresentation({
      scaleFactor: 2,
      buffer: nativeImage.createFromPath(join(assetBase, 'assets', 'menuicon-2x.png')).toPNG(),
    })

    this.tray = new Tray(icon)
    this.tray.setToolTip('lil agents')
    this.buildMenu()
    log.info('AppTray created')
  }

  buildMenu(): void {
    const tucoConfig = store.get('tuco')
    const kimConfig = store.get('kim')
    const theme = store.get('theme')

    const shortDir = (dir: string | undefined): string => {
      if (!dir) return 'not set'
      const home = homedir()
      const rel = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
      return rel.length > 45 ? '...' + rel.slice(-42) : rel
    }

    const charSubmenu = (
      char: CharacterName,
      provider: AgentProvider,
      size: CharacterSize
    ): Electron.MenuItemConstructorOptions[] => [
      {
        label: 'Provider',
        submenu: PROVIDERS.map(p => ({
          label: p,
          type: 'radio' as const,
          checked: p === provider,
          click: () => {
            this.handlers.onProviderChange(char, p)
            this.buildMenu()
          },
        })),
      },
      {
        label: 'Size',
        submenu: SIZES.map(s => ({
          label: s,
          type: 'radio' as const,
          checked: s === size,
          click: () => {
            store.set(char, { ...store.get(char), size: s })
            this.handlers.onSizeChange(char, s)
            this.buildMenu()
          },
        })),
      },
      {
        label: `Folder: ${shortDir(store.get(char).workDir)}`,
        click: async () => {
          const { canceled, filePaths } = await dialog.showOpenDialog({
            title: `Set ${char}'s working directory`,
            properties: ['openDirectory'],
            defaultPath: store.get(char).workDir ?? homedir(),
          })
          if (!canceled && filePaths[0]) {
            store.set(char, { ...store.get(char), workDir: filePaths[0] })
            this.handlers.onWorkDirChange(char, filePaths[0])
            this.buildMenu()
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Hide',
        click: () => this.handlers.onHide(char),
      },
    ]

    const menu = Menu.buildFromTemplate([
      {
        label: 'Tuco',
        submenu: charSubmenu('tuco', tucoConfig.provider, tucoConfig.size),
      },
      {
        label: 'Kim',
        submenu: charSubmenu('kim', kimConfig.provider, kimConfig.size),
      },
      { type: 'separator' },
      {
        label: 'Theme',
        submenu: THEMES.map(t => ({
          label: t,
          type: 'radio' as const,
          checked: t === theme,
          click: () => {
            store.set('theme', t)
            this.handlers.onThemeChange(t)
            this.buildMenu()
          },
        })),
      },
      { type: 'separator' },
      {
        label: 'Sounds',
        type: 'checkbox',
        checked: store.get('soundEnabled'),
        click: () => {
          store.set('soundEnabled', !store.get('soundEnabled'))
        },
      },
      { type: 'separator' },
      { label: 'Check for Updates', click: () => this.handlers.onCheckUpdates() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => this.handlers.onQuit(),
      },
    ])

    this.tray.setContextMenu(menu)
  }

  destroy(): void {
    this.tray.destroy()
  }
}
