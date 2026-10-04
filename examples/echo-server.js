'use strict'
const DHT = require('hyperdht')
async function main () {
  const dht = new DHT()
  const keyPair = process.env.SEED
    ? DHT.keyPair(Buffer.from(process.env.SEED, 'hex'))
    : DHT.keyPair()
  const server = dht.createServer(socket => {
    console.log('Connected:', socket.remotePublicKey.toString('hex'))
    socket.on('error', err => console.error('Peer:', err.message))
    socket.pipe(socket)
  })
  await server.listen(keyPair)
  console.log('REMOTE_KEY=' + keyPair.publicKey.toString('hex'))
  process.once('SIGINT', async () => {
    await server.close()
    await dht.destroy()
  })
}
main().catch(err => { console.error(err); process.exitCode = 1 })
