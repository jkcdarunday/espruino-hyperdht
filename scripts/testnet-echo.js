'use strict'
// node scripts/testnet-echo.js <reachable-host-IPv4> [base-port] [--open]
const DHT = require('hyperdht')
const { isIPv4 } = require('node:net')

async function main () {
  const host = process.argv[2]
  const port = Number(process.argv[3] || 52738)
  if (!isIPv4(host) || !Number.isInteger(port) || port < 1024 || port > 65530) {
    throw new Error('Usage: node scripts/testnet-echo.js <host-IPv4> [base-port] [--open]')
  }
  const nodes = []
  let server
  let stopping = false
  async function stop () {
    if (stopping) return
    stopping = true
    if (server) await server.close()
    for (const d of nodes.reverse()) await d.destroy()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const bootstrap = [{ host, port }]
    for (let i = 0; i < 6; i++) {
      const seeds = Array.from({ length: 6 }, (_, j) => ({ host, port: port + j }))
        .filter(n => n.port !== port + i)
      nodes.push(DHT.bootstrapper(port + i, host, { host, bootstrap: seeds }))
    }
    await Promise.all(nodes.map(d => d.fullyBootstrapped()))
    const firewalled = !process.argv.includes('--open')
    const peer = new DHT({ host, bootstrap, ephemeral: true, firewalled, quickFirewall: false })
    nodes.push(peer)
    server = peer.createServer({ shareLocalAddress: false, holepunch: () => true }, socket => {
      console.log('CONNECTED', socket.remotePublicKey.toString('hex'))
      socket.on('error', e => console.log('PEER_ERROR', e.message))
      socket.pipe(socket)
    })
    let punches = 0
    const onPunch = server._onpeerholepunch
    server._onpeerholepunch = function (...args) {
      console.log('PUNCH_RPC', ++punches)
      return onPunch.apply(this, args)
    }
    await server.listen()
    // Confirm advertisement before exposing a key to the hardware client.
    const probe = new DHT({ host, bootstrap, ephemeral: true })
    nodes.push(probe)
    let records = 0
    for await (const reply of probe.findPeer(server.publicKey)) records++
    if (!records) throw new Error('Test peer was not advertised')
    console.log('ANNOUNCED_RECORDS=' + records)
    console.log('FIREWALLED=' + peer.firewalled)
    console.log('BOOTSTRAP=' + host + ':' + port)
    console.log('REMOTE_KEY=' + server.publicKey.toString('hex'))
  } catch (e) {
    await stop()
    throw e
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
