import Store from 'electron-store'
import type { AppStore } from '../shared/types'

const store = new Store<AppStore>({
  defaults: {
    bruce: { provider: 'claude', size: 'large', history: [] },
    jazz: { provider: 'claude', size: 'large', history: [] },
    theme: 'midnight',
    hasCompletedOnboarding: false,
    soundEnabled: true,
    disableGpu: false,
    openclaw: { url: 'http://localhost:8080', authToken: '' },
  },
})

export default store
