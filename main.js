const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const net = require('node:net')
const fs = require('node:fs')

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))

const DIAL_TIMEOUT_MS = 5000

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mwakwanda Backoffice',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // page and Node world stay separate; only the
      nodeIntegration: false, // bridge in preload.js is exposed to the page
    },
  })

  // The loaded page is remote and may set its own <title>; keep ours instead.
  win.on('page-title-updated', (event) => event.preventDefault())

  win.loadURL(config.backofficeUrl)
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Dials the printer directly over TCP and writes the raw ESC/POS bytes — the
// exact thing a browser page can never do itself. Mirrors the Go
// PrinterService.TestPrint behavior: short dial timeout, single write, clean
// close, and an error message specific enough to show a user directly.
ipcMain.handle('printer:print', async (_event, { ip, port, dataBase64 }) => {
  if (!ip) throw new Error('No printer IP provided')
  const targetPort = port || 9100
  const data = Buffer.from(dataBase64, 'base64')

  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`Could not reach printer at ${ip}:${targetPort}: ${err.message}`))
    }

    socket.setTimeout(DIAL_TIMEOUT_MS)
    socket.once('timeout', () => fail(new Error('connection timed out')))
    socket.once('error', fail)

    socket.connect(targetPort, ip, () => {
      socket.write(data, (err) => {
        if (err) return fail(err)
        socket.end()
        if (!settled) {
          settled = true
          resolve({ success: true })
        }
      })
    })
  })
})
