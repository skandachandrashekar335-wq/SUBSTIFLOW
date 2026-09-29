import { contextBridge, ipcRenderer } from 'electron'

type IpcResult = { data?: unknown; error?: string }

function sync<T>(channel: string, payload: unknown): IpcResult {
  return ipcRenderer.sendSync(channel, payload) as IpcResult
}

contextBridge.exposeInMainWorld('electron', {
  db: {
    allSync: (sql: string, params: unknown[]): IpcResult => sync('db:all', { sql, params }),
    getSync: (sql: string, params: unknown[]): IpcResult => sync('db:get', { sql, params }),
    runSync: (sql: string, params: unknown[]): IpcResult => sync('db:run', { sql, params }),
    execSync: (sql: string): IpcResult => sync('db:exec', { sql }),

    query: (sql: string, params?: unknown[]): Promise<IpcResult> =>
      ipcRenderer.invoke('db:query', sql, params),
    transaction: (sqls: { sql: string; params: unknown[] }[]): Promise<IpcResult> =>
      ipcRenderer.invoke('db:transaction', sqls),
  },
  backup: {
    exportBackup: (): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('backup:export'),
    importBackup: (filePath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('backup:import', filePath),
    autoInfo: (): Promise<{
      directory?: string
      keep?: number
      count?: number
      lastBackup?: string | null
      error?: string
    }> => ipcRenderer.invoke('backup:autoInfo'),
  },
  app: {
    getInfo: (): Promise<{
      version: string
      name: string
      userDataPath: string
      dbPath: string
      isDev: boolean
    }> => ipcRenderer.invoke('app:info'),
  },
  print: {
    print: (html?: string): Promise<{ success: boolean; error?: string; canceled?: boolean }> =>
      ipcRenderer.invoke('print', html),
  },
})
