import { autoUpdater } from 'electron-updater'
import { dialog, app } from 'electron'
import log from './logger'

export class AppUpdater {
  private launchTimer: ReturnType<typeof setTimeout> | null = null
  private manualCheck = false

  constructor() {
    autoUpdater.logger = log
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('update-available', info => {
      log.info(`Update available: ${info.version}`)
      dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `Version ${info.version} is available`,
        detail: "Downloading in the background. You'll be notified when it's ready to install.",
        buttons: ['OK'],
      })
    })

    autoUpdater.on('update-not-available', () => {
      log.info('No update available')
      if (this.manualCheck) {
        this.manualCheck = false
        dialog.showMessageBox({
          type: 'info',
          title: 'No Updates',
          message: "You're up to date!",
          buttons: ['OK'],
        })
      }
    })

    autoUpdater.on('update-downloaded', info => {
      log.info(`Update downloaded: ${info.version}`)
      dialog.showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} downloaded`,
        detail: 'Restart now to apply the update?',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
    })

    autoUpdater.on('error', err => {
      log.warn('Updater error:', err)
      if (this.manualCheck) {
        this.manualCheck = false
        dialog.showMessageBox({
          type: 'error',
          title: 'Update Error',
          message: 'Could not check for updates',
          detail: String(err.message),
          buttons: ['OK'],
        })
      }
    })
  }

  start(): void {
    if (!app.isPackaged) {
      log.info('Updater: skipped in dev mode')
      return
    }
    this.launchTimer = setTimeout(() => {
      log.info('Updater: checking on launch')
      void autoUpdater.checkForUpdates()
    }, 10_000)
  }

  checkNow(): void {
    if (!app.isPackaged) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Dev Mode',
        message: 'Update checks are disabled in dev mode',
        buttons: ['OK'],
      })
      return
    }
    this.manualCheck = true
    log.info('Updater: manual check')
    void autoUpdater.checkForUpdates()
  }

  stop(): void {
    if (this.launchTimer) { clearTimeout(this.launchTimer); this.launchTimer = null }
  }
}
