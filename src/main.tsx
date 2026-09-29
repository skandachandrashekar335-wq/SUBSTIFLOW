import React from 'react'
import ReactDOM from 'react-dom/client'
// HashRouter keeps deep links working when the app is loaded from `file://`
// in the packaged build (BrowserRouter would resolve against the file path).
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)