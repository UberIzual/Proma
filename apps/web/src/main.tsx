/**
 * Proma Web Frontend
 * React + Vite
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// Import electron API bridge
import './lib/electron-bridge'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
