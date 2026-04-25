import { useEffect, useState } from 'react'

const VIDEO_MAP: Record<string, string> = {
  bruce: 'asset://walk-bruce-01.webm',
  jazz: 'asset://walk-jazz-01.webm',
}

const FALLBACK_MAP: Record<string, string> = {
  bruce: 'asset://walk-bruce-01.png',
  jazz: 'asset://walk-jazz-01.png',
}

function getCharacter(): string {
  return new URLSearchParams(location.search).get('char') ?? 'bruce'
}

type WalkerAPI = {
  onClick: () => void
  signalReady: () => void
  onFlip: (cb: (f: boolean) => void) => void
  onBubbleShow: (cb: (text: string, variant: string) => void) => void
  onBubbleHide: (cb: () => void) => void
  onSound: (cb: (file: string) => void) => void
}

export default function WalkerView() {
  const [flipped, setFlipped] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const [bubble, setBubble] = useState<{ text: string; variant: string } | null>(null)
  const char = getCharacter()
  const videoSrc = VIDEO_MAP[char] ?? VIDEO_MAP.bruce
  const fallbackSrc = FALLBACK_MAP[char] ?? FALLBACK_MAP.bruce

  useEffect(() => {
    const api = (window as Window & { walkerAPI?: WalkerAPI }).walkerAPI
    if (!api) return
    api.onFlip(setFlipped)
    api.onBubbleShow((text, variant) => setBubble({ text, variant }))
    api.onBubbleHide(() => setBubble(null))
    api.onSound(file => {
      const audio = new Audio(`asset://${file}`)
      audio.play().catch(() => {})
    })
    api.signalReady()
  }, [])

  const handleClick = () => {
    const api = (window as Window & { walkerAPI?: WalkerAPI }).walkerAPI
    api?.onClick()
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
          src={videoSrc}
          autoPlay
          muted
          loop
          playsInline
          onError={() => setVideoFailed(true)}
          style={mediaStyle}
        />
      )}
    </div>
  )
}
