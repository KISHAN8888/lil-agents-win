import { protocol, app } from 'electron'
import { join, extname } from 'path'
import { existsSync, readFileSync } from 'fs'
import log from '../logger'

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

export function registerAssetProtocol(): void {
  protocol.handle('asset', request => {
    const filename = decodeURIComponent(request.url.slice('asset://'.length)).replace(/\/+$/, '')
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const filePath = join(base, 'assets', filename)
    const exists = existsSync(filePath)
    log.info(`asset:// ${filename} → ${filePath} [exists=${exists}]`)

    if (!exists) {
      return new Response(`Not found: ${filePath}`, { status: 404 })
    }

    try {
      const data = readFileSync(filePath)
      const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(data.byteLength),
          // Allow video elements to re-request slices for looping
          'Accept-Ranges': 'bytes',
        },
      })
    } catch (err) {
      log.warn(`asset:// read error: ${filePath}`, err)
      return new Response('Read error', { status: 500 })
    }
  })
}
