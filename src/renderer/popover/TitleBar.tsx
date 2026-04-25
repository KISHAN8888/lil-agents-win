interface Props {
  char: string
  provider: string
  onClose: () => void
}

export function TitleBar({ char, provider, onClose }: Props) {
  return (
    <div className="title-bar">
      <div className="title-bar-left">
        <span className="title-bar-provider">{provider.toUpperCase()}</span>
        <span className="title-bar-char">{char}</span>
      </div>
      <button className="title-bar-close" onClick={onClose} title="Close">
        ✕
      </button>
    </div>
  )
}
