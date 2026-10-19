import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * DEMO DATA banner — shown only when the app was launched through
 * `npm run demo:launch`, which sets SUBSTIFLOW_DEMO=1 (surfaced by the
 * main process through `app:info.isDemo`). In the production profile the
 * flag is never set, so this component renders nothing and no production
 * screen changes.
 *
 * It is deliberately impossible to dismiss: the point is that nobody can
 * mistake demo data for real college data.
 */
export function DemoBanner() {
  const [isDemo, setIsDemo] = useState(false)
  const [dbPath, setDbPath] = useState<string | null>(null)

  useEffect(() => {
    window.electron?.app
      .getInfo()
      .then((info) => {
        if (info && 'isDemo' in info && info.isDemo) {
          setIsDemo(true)
          setDbPath('dbPath' in info && typeof info.dbPath === 'string' ? info.dbPath : null)
        }
      })
      .catch(() => setIsDemo(false))
  }, [])

  if (!isDemo) return null

  return (
    <div
      role="status"
      data-testid="demo-banner"
      className="sticky top-16 z-20 mb-4 flex items-start gap-3 rounded-xl border border-warning-300 bg-warning-50 px-4 py-3 shadow-sm"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning-600" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-warning-800">
          DEMO DATA — isolated sample database
        </p>
        <p className="text-sm text-warning-700">
          All faculty, sections, subjects and rooms are fictional demo records. Your real
          college data is untouched.
          {dbPath && (
            <>
              {' '}
              Database: <code className="break-all">{dbPath}</code>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
