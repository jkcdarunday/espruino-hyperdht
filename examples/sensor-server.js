'use strict'
const DHT = require('hyperdht')
const node = new DHT()
// Set ALLOWED_KEY to the provisioned device public key to restrict collection.
const seed = process.env.SEED
if (seed && !/^[a-f0-9]{64}$/i.test(seed)) throw new Error('Invalid SEED')
const allowed = process.env.ALLOWED_KEY
if (allowed && !/^[a-f0-9]{64}$/i.test(allowed)) throw new Error('Invalid ALLOWED_KEY')
const server = node.createServer(socket => {
  socket.on('error', err => console.error(err.message))
  if (allowed && socket.remotePublicKey.toString('hex') !== allowed.toLowerCase()) {
    socket.destroy(); return
  }
  let input = '', writable = true, latestAck = null
  function flush () {
    if (!writable || latestAck === null) return
    const ack = latestAck; latestAck = null
    writable = socket.write(ack) // Node false means accepted, wait for drain.
  }
  socket.on('drain', () => { writable = true; flush() })
  socket.on('data', bytes => {
    // Bound allocation before converting/concatenating attacker-controlled bytes.
    if (bytes.length > 4096 || input.length + bytes.length > 5120) return socket.destroy()
    input += bytes.toString('utf8')
    let end
    while ((end = input.indexOf('\n')) !== -1) {
      if (end > 1024) return socket.destroy()
      const line = input.slice(0, end); input = input.slice(end + 1)
      try {
        const reading = JSON.parse(line)
        if (!Number.isSafeInteger(reading.seq) || !Number.isFinite(reading.adc)) return socket.destroy()
        console.log(socket.remotePublicKey.toString('hex'), reading)
        latestAck = JSON.stringify({ack: reading.seq}) + '\n'
        flush()
      } catch { return socket.destroy() }
    }
    if (input.length > 1024) socket.destroy()
  })
})
async function main () {
  const keyPair = DHT.keyPair(seed ? Buffer.from(seed, 'hex') : undefined)
  await server.listen(keyPair)
  console.log('REMOTE_KEY=' + keyPair.publicKey.toString('hex'))
}
main().catch(err => { console.error(err); process.exitCode = 1; node.destroy() })
process.once('SIGINT', async () => { await server.close(); await node.destroy() })
