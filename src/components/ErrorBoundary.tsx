import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last-resort handler: if any page throws while rendering, the user gets a
 * readable message (and their data is safe in SQLite) instead of a white
 * screen. Errors are logged to the developer console as well.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-secondary-50">
        <div className="max-w-xl w-full bg-white border border-danger-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-danger-600" />
            <h1 className="text-lg font-semibold text-secondary-900">
              Something went wrong
            </h1>
          </div>
          <p className="text-sm text-secondary-600">
            This page hit an unexpected error. Your saved data is safe — SubstiFlow
            keeps everything in its local database. Try the page again, or reload
            the app.
          </p>
          <pre className="text-xs bg-secondary-50 border border-secondary-200 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="flex gap-3">
            <Button onClick={() => this.setState({ error: null })}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
