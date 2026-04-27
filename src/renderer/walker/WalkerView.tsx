import { useEffect, useRef, useState } from 'react'

const VIDEO_MAP: Record<string, string> = {
  tuco: 'asset://Walking monkey.webm',
  kim: 'asset://walk.webm',
}

const FALLBACK_MAP: Record<string, string> = {
  tuco: 'asset://Walking monkey.webm',
  kim: 'asset://walk.webm',
}

function getCharacter(): string {
  return new URLSearchParams(location.search).get('char') ?? 'tuco'
}

type WalkerAPI = {
  onClick: () => void
  signalReady: () => void
  setWorkDir: (path: string) => void
  ingest: (path: string, caption?: string) => void
  setModalOpen: (isOpen: boolean) => void
  onFlip: (cb: (f: boolean) => void) => void
  onWalking: (cb: (isWalking: boolean, seekTo?: number) => void) => void
  onBubbleShow: (cb: (text: string, variant: string) => void) => void
  onBubbleHide: (cb: () => void) => void
  onSound: (cb: (file: string) => void) => void
}

export default function WalkerView() {
  const [flipped, setFlipped] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const [bubble, setBubble] = useState<{ text: string; variant: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [ingestTarget, setIngestTarget] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const dragCounter = useRef(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const walkingRef = useRef(false)
  const char = getCharacter()
  const videoSrc = VIDEO_MAP[char] ?? VIDEO_MAP.tuco
  const fallbackSrc = FALLBACK_MAP[char] ?? FALLBACK_MAP.tuco

  useEffect(() => {
    const api = (window as Window & { walkerAPI?: WalkerAPI }).walkerAPI
    if (ingestTarget) {
      inputRef.current?.focus()
      api?.setModalOpen(true)
    } else {
      api?.setModalOpen(false)
    }
  }, [ingestTarget])

  useEffect(() => {
    const api = (window as Window & { walkerAPI?: WalkerAPI }).walkerAPI
    if (!api) return
    api.onFlip(setFlipped)
    api.onWalking((isWalking, seekTo) => {
      walkingRef.current = isWalking
      const v = videoRef.current
      if (!v) return
      if (isWalking) {
        if (seekTo !== undefined) v.currentTime = seekTo
        v.play().catch(() => {})
      } else {
        v.pause()
        v.currentTime = 0
      }
    })
    api.onBubbleShow((text, variant) => setBubble({ text, variant }))
    api.onBubbleHide(() => setBubble(null))
    api.onSound(file => {
      const audio = new Audio(`asset://${file}`)
      audio.play().catch(() => {})
    })
    api.signalReady()
  }, [char])

  const getAPI = () => (window as Window & { walkerAPI?: WalkerAPI }).walkerAPI

  const handleClick = () => getAPI()?.onClick()

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounter.current++
    setDragOver(true)
  }

  const handleDragLeave = () => {
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDragOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'link'
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const path = (file as File & { path?: string }).path
    if (path) {
      setIngestTarget(path)
      setCaption('')
    }
  }

  const handleIngestSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (ingestTarget) {
      getAPI()?.ingest(ingestTarget, caption)
      setIngestTarget(null)
    }
  }

  const transform = flipped ? 'scaleX(-1)' : 'scaleX(1)'
  const mediaStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '100%',
    height: 'calc(100% - var(--bubble-h))',
    objectFit: 'contain',
    objectPosition: 'bottom center',
    transform,
    transition: 'transform 0.05s',
    cursor: 'pointer',
  }

  return (
    <div
      onClick={handleClick}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        width: '100vw',
        height: '100vh',
        position: 'relative',
        overflow: 'hidden',
        background: 'transparent',
      }}
    >
      {bubble !== null && (
        <div className="bubble">
          <span className={`bubble-text${bubble.variant === 'complete' ? ' bubble-complete' : ''}`}>
            {bubble.text}
          </span>
        </div>
      )}
      {videoFailed ? (
        <img src={fallbackSrc} alt={char} style={mediaStyle} />
      ) : (
        <video
          ref={videoRef}
          src={videoSrc}
          muted
          loop
          playsInline
          preload="auto"
          onCanPlay={v => {
            if (walkingRef.current) (v.target as HTMLVideoElement).play().catch(() => {})
            else {
              const el = v.target as HTMLVideoElement
              el.pause()
              el.currentTime = 0
            }
          }}
          onError={() => setVideoFailed(true)}
          style={mediaStyle}
        />
      )}
      {dragOver && (
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '100%',
          height: 'calc(100% - var(--bubble-h))',
          background: 'rgba(99, 179, 237, 0.25)',
          border: '2px dashed #63b3ed',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
        }}>
          📁 ingest file
        </div>
      )}

      {ingestTarget && (
        <div 
          onClick={e => e.stopPropagation()}
          style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          padding: 8,
        }}>
          <form onSubmit={handleIngestSubmit} style={{
            background: 'var(--bg-popover, #1a1a1a)',
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            padding: 12,
            width: '100%',
            maxWidth: 240,
            boxShadow: '0 8px 16px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Add to vault?
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder="Caption (optional)"
              value={caption}
              onChange={e => setCaption(e.target.value)}
              style={{
                width: '100%',
                background: '#000',
                border: '1px solid #444',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: 12,
                marginBottom: 8,
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setIngestTarget(null)} style={{ background: 'transparent', border: 'none', color: '#888', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
              <button type="submit" style={{ background: '#3182ce', border: 'none', color: '#fff', fontSize: 11, padding: '4px 10px', borderRadius: 4, cursor: 'pointer' }}>Ingest</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
