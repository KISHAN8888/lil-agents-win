import Store from 'electron-store'
import type { AppStore } from '../shared/types'

const store = new Store<AppStore>({
  defaults: {
    tuco: { provider: 'claude', size: 'large', sessions: {} },
    kim: { provider: 'claude', size: 'large', sessions: {} },
    theme: 'midnight',
    hasCompletedOnboarding: false,
    soundEnabled: true,
    disableGpu: false,
    openclaw: { url: 'http://localhost:8080', authToken: '' },
  },
})

export default store
