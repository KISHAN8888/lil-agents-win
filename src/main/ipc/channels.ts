export const IPC = {
  // Walker → Main
  WALKER_CLICKABLE: 'walker:clickable',
  WALKER_CLICK: 'walker:click',

  // Main → Walker
  WALKER_POSITION: 'walker:position',
  WALKER_FLIP: 'walker:flip',

  // Session (bidirectional)
  SESSION_SEND: 'session:send',
  SESSION_TERMINATE: 'session:terminate',
  SESSION_TEXT: 'session:text',
  SESSION_TOOL_USE: 'session:toolUse',
  SESSION_TOOL_RESULT: 'session:toolResult',
  SESSION_TURN_COMPLETE: 'session:turnComplete',
  SESSION_READY: 'session:ready',
  SESSION_ERROR: 'session:error',
  SESSION_EXIT: 'session:exit',

  // Popover → Main
  POPOVER_READY: 'popover:ready',
  POPOVER_CLOSE: 'popover:close',
  POPOVER_COPY_LAST: 'popover:copyLast',

  // Theme
  THEME_SET: 'theme:set',
  THEME_GET: 'theme:get',
  THEME_APPLY: 'theme:apply',

  // Taskbar geometry (Main → renderers)
  TASKBAR_GEOMETRY: 'taskbar:geometry',

  // Walker renderer lifecycle
  WALKER_READY: 'walker:ready',
  WALKER_SOUND: 'walker:sound',

  // Bubble windows
  BUBBLE_SHOW: 'bubble:show',
  BUBBLE_HIDE: 'bubble:hide',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
