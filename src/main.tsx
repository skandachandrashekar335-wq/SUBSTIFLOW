import React from 'react'
import ReactDOM from 'react-dom/client'
// HashRouter keeps deep links working when the app is loaded from `file://`
// in the packaged build (BrowserRouter would resolve against the file path).
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Opt in to React Router v7 behaviour while staying on v6.30:
        v7_startTransition wraps router state updates in React.startTransition,
        v7_relativeSplatPath adopts the v7 relative resolution for the `*`
        fallback route. Both also silence the v7 future-flag console warnings. */}
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </React.StrictMode>,
)