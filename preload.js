// Runs in an isolated context with access to Node APIs, but the page itself
// never gets direct Node/Electron access — only the specific functions we
// choose to expose here via contextBridge. This is what lets the backoffice
// web page (untrusted, same as any website) safely call into native code.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Marks that we're running inside the terminal shell, not a normal browser —
  // the Vue app uses this to decide whether to show/enable print actions.
  isTerminal: true,

  // Sends raw bytes to a printer at ip:port over TCP. `dataBase64` is the
  // ESC/POS payload (rendered server-side), base64-encoded for safe IPC transit.
  // Resolves on success, rejects with a descriptive error otherwise.
  print: (ip, port, dataBase64) => ipcRenderer.invoke('printer:print', { ip, port, dataBase64 }),
})
