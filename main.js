const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const path = require('node:path')
const net = require('node:net')
const fs = require('node:fs')
const ThermalPrinter = require('node-thermal-printer').printer
const PrinterTypes = require('node-thermal-printer').types

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'))

const DIAL_TIMEOUT_MS = 5000

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mwakwanda Management Dashboard',
    icon: path.join(__dirname, 'logo', 'mwakwanda-logo.ico'),
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
  Menu.setApplicationMenu(null)
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
      console.log(`Print failed for ${ip}:${targetPort}: ${err.message}`)
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
          console.log(`Print succeeded for ${ip}:${targetPort}`)
          resolve({ success: true })
        }
      })
    })
  })
})

// node-thermal-printer's built-in network interface calls socket.destroy()
// right after write()'s callback fires, which only means the bytes were
// handed to the OS — not that the printer received them. On a real network
// link that abrupt reset can truncate the job before it fully arrives, so
// execute() resolves "successfully" with nothing printed. This interface
// mirrors the raw-socket handler above instead: write, then end() gracefully
// and wait for the socket to actually close before resolving.
function createNetworkInterface(host, port, timeoutMs) {
  return {
    async isPrinterConnected() {
      return true
    },
    async execute(buffer) {
      return new Promise((resolve, reject) => {
        const socket = new net.Socket()
        let settled = false

        const fail = (err) => {
          if (settled) return
          settled = true
          socket.destroy()
          reject(err)
        }

        socket.setTimeout(timeoutMs)
        socket.once('timeout', () => fail(new Error('connection timed out')))
        socket.once('error', fail)
        socket.once('close', () => {
          if (!settled) {
            settled = true
            resolve()
          }
        })

        socket.connect(port, host, () => {
          socket.write(buffer, (err) => {
            if (err) return fail(err)
            socket.end()
          })
        })
      })
    },
  }
}

// Builds and prints a receipt via node-thermal-printer's ESC/POS command
// builder instead of raw pre-rendered bytes. The printer's IP is supplied
// per-call (the renderer fetches it from the backoffice server per branch)
// rather than hardcoded, since every branch has a different printer.
ipcMain.handle('printer:printReceipt', async (_event, { ip, port }) => {
  if (!ip) throw new Error('No printer IP provided')
  const targetPort = port || 9100

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: createNetworkInterface(ip, targetPort, DIAL_TIMEOUT_MS),
  })

  printer.alignCenter()
  printer.bold(true)
  printer.println('STORE NAME')
  printer.bold(false)
  printer.println('Network Print Successful')
  printer.cut()

  try {
    await printer.execute()
    console.log(`Print succeeded for ${ip}:${targetPort}`)
    printer.clear()
    return { success: true }
  } catch (err) {
    console.log(`Print failed for ${ip}:${targetPort}: ${err.message}`)
    throw new Error(`Could not reach printer at ${ip}:${targetPort}: ${err.message}`)
  }
})
