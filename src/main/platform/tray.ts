import { Tray, Menu, app, nativeImage } from 'electron'
import { join } from 'path'
import store from '../store'
import type { CharacterName, AgentProvider, CharacterSize, ThemeName } from '../../shared/types'
import log from '../logger'

export interface TrayHandlers {
  onProviderChange: (char: CharacterName, provider: AgentProvider) => void
  onSizeChange: (char: CharacterName, size: CharacterSize) => void
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
    const bruceConfig = store.get('bruce')
    const jazzConfig = store.get('jazz')
    const theme = store.get('theme')

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
            store.set(char, { ...store.get(char), provider: p })
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
      { type: 'separator' },
      {
        label: 'Hide',
        click: () => this.handlers.onHide(char),
      },
    ]

    const menu = Menu.buildFromTemplate([
      {
        label: 'Bruce',
        submenu: charSubmenu('bruce', bruceConfig.provider, bruceConfig.size),
      },
      {
        label: 'Jazz',
        submenu: charSubmenu('jazz', jazzConfig.provider, jazzConfig.size),
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
