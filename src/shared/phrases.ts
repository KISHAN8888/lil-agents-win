export const THINKING_PHRASES = [
  'pondering...',
  'thinking...',
  'working on it...',
  'let me check...',
  'hmm...',
  'on it...',
  'computing...',
  'one sec...',
  'figuring it out...',
  'almost there...',
]

export const COMPLETE_PHRASES = [
  'done!',
  'all set!',
  'finished!',
  'there you go!',
  'check it out!',
]

export function randomPhrase(phrases: string[]): string {
  return phrases[Math.floor(Math.random() * phrases.length)]
}
