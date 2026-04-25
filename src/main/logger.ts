import log from 'electron-log'
import { app } from 'electron'

log.transports.file.level = 'info'
log.transports.console.level = 'debug'

if (app?.isPackaged) {
  log.transports.console.level = false
}

export default log
