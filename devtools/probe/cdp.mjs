// Minimal CDP driver: evaluate one expression in the Dock renderer and print the result.
// Usage: node devtools/probe/cdp.mjs "<expression>"
// Requires the app to be started with --remote-debugging-port=9222 (dev only).

const PORT = process.env.QL_CDP_PORT ?? '9222'
const expr = process.argv[2] ?? '1'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

function call(method, params = {}) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

await call('Runtime.enable')
try {
  const res = await call('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (res.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(res.exceptionDetails, null, 2))
    process.exit(2)
  }
  const v = res.result?.value
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
} finally {
  ws.close()
}
