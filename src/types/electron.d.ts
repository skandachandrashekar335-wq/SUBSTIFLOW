export {}

declare global {
  interface Window {
    electron?: {
      db: {
        allSync: (sql: string, params: unknown[]) => { data?: unknown[]; error?: string }
        getSync: (sql: string, params: unknown[]) => { data?: unknown; error?: string }
        runSync: (
          sql: string,
          params: unknown[]
        ) => { data?: { changes: number; lastInsertRowid: number | bigint }; error?: string }
        execSync: (sql: string) => { data?: unknown; error?: string }

        query: (
          sql: string,
          params?: unknown[]
        ) => Promise<{ data?: unknown[]; error?: string }>
        transaction: (
          sqls: { sql: string; params: unknown[] }[]
        ) => Promise<{ data?: unknown[]; error?: string }>
      }
      backup: {
        exportBackup: () => Promise<{ success: boolean; path?: string; error?: string }>
        importBackup: (filePath: string) => Promise<{ success: boolean; error?: string }>
        autoInfo: () => Promise<{
          directory?: string
          keep?: number
          count?: number
          lastBackup?: string | null
          error?: string
        }>
      }
      app: {
        getInfo: () => Promise<{
          version: string
          name: string
          userDataPath: string
          dbPath: string
          isDev: boolean
        }>
      }
      print: {
        print: (html?: string) => Promise<{ success: boolean; error?: string; canceled?: boolean }>
      }
    }
  }
}
