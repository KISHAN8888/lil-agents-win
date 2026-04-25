import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'

let _onFlip: ((flipped: boolean) => void) | null = null
let _onWalking: ((isWalking: boolean, seekTo?: number) => void) | null = null
let _onBubbleShow: ((text: string, variant: string) => void) | null = null
let _onBubbleHide: (() => void) | null = null
let _onSound: ((file: string) => void) | null = null

ipcRenderer.on(IPC.WALKER_FLIP, (_e, flipped: boolean) => _onFlip?.(flipped))
ipcRenderer.on(IPC.WALKER_WALKING, (_e, isWalking: boolean, seekTo?: number) => _onWalking?.(isWalking, seekTo))
ipcRenderer.on(IPC.BUBBLE_SHOW, (_e, text: string, variant: string) => _onBubbleShow?.(text, variant))
ipcRenderer.on(IPC.BUBBLE_HIDE, () => _onBubbleHide?.())
ipcRenderer.on(IPC.WALKER_SOUND, (_e, file: string) => _onSound?.(file))

contextBridge.exposeInMainWorld('walkerAPI', {
  setClickable: (clickable: boolean) => ipcRenderer.send(IPC.WALKER_CLICKABLE, clickable),
  onClick: () => ipcRenderer.send(IPC.WALKER_CLICK),
  signalReady: () => ipcRenderer.send(IPC.WALKER_READY),
  setWorkDir: (path: string) => ipcRenderer.send(IPC.WALKER_SET_WORKDIR, path),
  onFlip: (cb: (flipped: boolean) => void) => { _onFlip = cb },
  onWalking: (cb: (isWalking: boolean, seekTo?: number) => void) => { _onWalking = cb },
  onBubbleShow: (cb: (text: string, variant: string) => void) => { _onBubbleShow = cb },
  onBubbleHide: (cb: () => void) => { _onBubbleHide = cb },
  onSound: (cb: (file: string) => void) => { _onSound = cb },
})
