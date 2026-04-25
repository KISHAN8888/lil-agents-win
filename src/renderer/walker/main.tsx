import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WalkerView from './WalkerView'
import './walker.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalkerView />
  </StrictMode>
)
