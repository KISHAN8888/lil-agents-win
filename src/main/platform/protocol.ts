import { protocol, net, app } from 'electron'
import { join } from 'path'
import log from '../logger'

/**
 * Registers the asset:// protocol so renderers can load files from the assets
 * directory without direct filesystem access.
 *
 * Usage in renderer: <video src="asset://walk-bruce-01.webm">
 *
 * Dev:  resolves to <appRoot>/assets/<filename>
 * Prod: resolves to <resourcesPath>/assets/<filename>
 */
export function registerAssetProtocol(): void {
  protocol.handle('asset', request => {
    const filename = decodeURIComponent(request.url.slice('asset://'.length)).replace(/\/+$/, '')
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const filePath = join(base, 'assets', filename)
    log.debug(`asset:// → ${filePath}`)
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'))
  })
}
