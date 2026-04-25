import { useState, useRef, useEffect } from 'react'

const SLASH_COMMANDS = ['/clear', '/copy', '/help']

interface Props {
  onSubmit: (text: string) => void
  onCopy: () => void
  onClear: () => void
  onClose: () => void
}

export function InputBar({ onSubmit, onCopy, onClear, onClose }: Props) {
  const [value, setValue] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setValue(v)
    if (v.startsWith('/')) {
      setSuggestions(SLASH_COMMANDS.filter(c => c.startsWith(v)))
      setSelectedIdx(0)
    } else {
      setSuggestions([])
    }
  }

  const commit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setValue('')
    setSuggestions([])

    if (trimmed === '/clear') { onClear(); return }
    if (trimmed === '/copy') { onCopy(); return }
    if (trimmed === '/help') { onSubmit('/help'); return }
    onSubmit(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onClose(); return }

    if (suggestions.length > 0) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(0, i - 1)); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(suggestions.length - 1, i + 1)); return }
      if (e.key === 'Tab') { e.preventDefault(); commit(suggestions[selectedIdx]); return }
    }

    if (e.key === 'Enter') commit(value)
  }

  const pickSuggestion = (s: string) => {
    commit(s)
    inputRef.current?.focus()
  }

  return (
    <div className="input-bar">
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s, i) => (
            <div
              key={s}
              className={`suggestion${i === selectedIdx ? ' selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); pickSuggestion(s) }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        className="input-field"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="message…"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  )
}
