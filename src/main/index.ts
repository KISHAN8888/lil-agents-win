import { app, protocol } from 'electron'
import { AppController } from './controller/AppController'
import { registerAssetProtocol } from './platform/protocol'
import store from './store'
import log from './logger'

// Must be called before app is ready — enables media streaming via asset://
protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

if (store.get('disableGpu')) {
  app.disableHardwareAcceleration()
}

// Register asset:// before any window is created
app.whenReady().then(() => {
  registerAssetProtocol()
  log.info('App ready')
  const controller = new AppController()
  controller.init()

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      controller.destroy()
      app.quit()
    }
  })
})

app.on('second-instance', () => {
  // future: focus open popover
})
