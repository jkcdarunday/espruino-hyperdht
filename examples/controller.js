'use strict'
// CONTROLLER_SEED=<64 hex> DEVICE_KEY=<64 hex> node examples/controller.js status
const DHT = require('hyperdht')
const seed = process.env.CONTROLLER_SEED
const key = process.env.DEVICE_KEY
if (!/^[0-9a-f]{64}$/i.test(seed || '') || !/^[0-9a-f]{64}$/i.test(key || '')) {
  throw new Error('Set CONTROLLER_SEED and DEVICE_KEY to 64 hex characters')
}
const keyPair = DHT.keyPair(Buffer.from(seed, 'hex'))
console.log('Authorize controller key:', keyPair.publicKey.toString('hex'))
const node = new DHT({ keyPair })
const socket = node.connect(Buffer.from(key, 'hex'))
let response = ''
const timer = setTimeout(() => socket.destroy(new Error('Command timed out')), 45000)
socket.on('open', () => socket.write((process.argv[2] || 'status') + '\n'))
socket.on('data', data => {
  response += data.toString()
  if (response.length > 1024) return socket.destroy(new Error('Response too large'))
  if (response.includes('\n')) { console.log(response.trim()); socket.end() }
})
socket.on('error', err => { console.error(err.message); process.exitCode = 1 })
socket.on('close', async () => { clearTimeout(timer); await node.destroy() })
