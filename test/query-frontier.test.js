'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { spawn } = require('node:child_process')
const path = require('node:path')
const c = require('compact-encoding')
const peer = require('dht-rpc/lib/peer')

async function frontier (internal) {
  const sockets = []
  const requestFlags = []
  let baseReplies = 0
  let leafVisits = 0
  const candidates = []
  for (let port = 31000; port < 65000; port++) {
    candidates.push({ host: '127.0.0.1', port, id: peer.id('127.0.0.1', port) })
  }
  function take (predicate, count) {
    const selected = candidates.filter(predicate).slice(0, count)
    assert.equal(selected.length, count)
    return selected
  }
  const base = take(n => n.id[0] >= 0x80 && n.id[0] < 0xc0, 10)
  const gateway = take(n => n.id[0] >= 0x30 && n.id[0] < 0x40, 1)[0]
  const leaf = take(n => n.id[0] >= 0x10 && n.id[0] < 0x20, 1)[0]
  const irrelevant = take(n => n.id[0] >= 0xe0, 150)

  // Use the reference compact codecs; every reply has a source-validated ID.
  function reply (socket, node, packet, remote, closer, value) {
    const state = { start: 0, end: 2, buffer: null }
    c.uint16.preencode(state, 0)
    peer.ipv4.preencode(state, remote)
    c.fixed32.preencode(state, node.id)
    if (closer.length) peer.ipv4Array.preencode(state, closer)
    if (value) c.buffer.preencode(state, value)
    state.buffer = Buffer.alloc(state.end)
    state.buffer[state.start++] = 0x13
    state.buffer[state.start++] = 1 | (closer.length ? 4 : 0) | (value ? 16 : 0)
    c.uint16.encode(state, c.decode(c.uint16, packet.subarray(2, 4)))
    peer.ipv4.encode(state, remote)
    c.fixed32.encode(state, node.id)
    if (closer.length) peer.ipv4Array.encode(state, closer)
    if (value) c.buffer.encode(state, value)
    socket.send(state.buffer, remote.port, remote.host)
  }
  try {
    for (const node of [...base, gateway, leaf]) {
      const socket = dgram.createSocket('udp4')
      sockets.push(socket)
      socket.on('message', (packet, info) => {
        requestFlags.push(packet[1])
        const remote = { host: info.address, port: info.port }
        if (node === gateway) {
          // Wait until all ten responsive seeds have filled the nearest set.
          // The useful referral follows enough irrelevant entries to exhaust
          // the unpatched small client's entire 128-entry seen budget.
          setTimeout(() => reply(socket, node, packet, remote, [...irrelevant, leaf]), 100)
        } else if (node === leaf) {
          leafVisits++
          reply(socket, node, packet, remote, [], Buffer.from('found'))
        } else {
          baseReplies++
          reply(socket, node, packet, remote, [], null)
        }
      })
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(node.port, node.host, resolve)
      })
    }
    const binary = process.env.FRONTIER_BIN || path.join(__dirname, '../build/query-frontier')
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env }
      if (internal) env.FRONTIER_INTERNAL = '1'; else delete env.FRONTIER_INTERNAL
      const child = spawn(binary, [...base, gateway].map(n => String(n.port)), { env })
      let output = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Query fixture timed out')) }, 6000)
      child.stdout.on('data', b => { output += b })
      child.stderr.on('data', b => { output += b })
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    assert.ok(requestFlags.every(flags => !!(flags & 4) === internal), 'wire internal flag matches query kind')
    assert.equal(baseReplies, 10, 'fill the nearest-node set before the noisy referral')
    assert.equal(result.code, 0, result.output)
    assert.ok(leafVisits > 0, 'must reach the useful record holder after the irrelevant referrals')
    assert.match(result.output, /FRONTIER_OK/)
  } finally {
    for (const socket of sockets) socket.close()
  }
}

test('bounded native discovery ignores irrelevant referrals and finds a closer record', { timeout: 10000 }, () => frontier(false))
test('internal routing queries preserve their wire namespace', { timeout: 10000 }, () => frontier(true))


test('early discovery completion cancels silent RPC requests', { timeout: 10000 }, async () => {
  const sockets = []
  let silentPackets = 0
  try {
    for (let i = 0; i < 11; i++) {
      const socket = dgram.createSocket('udp4')
      sockets.push(socket)
      socket.on('message', (packet, remote) => {
        if (i !== 0) { silentPackets++; return }
        const state = { start: 0, end: 2, buffer: null }
        c.uint16.preencode(state, 0)
        peer.ipv4.preencode(state, { host: remote.address, port: remote.port })
        c.fixed32.preencode(state, peer.id('127.0.0.1', socket.address().port))
        c.buffer.preencode(state, Buffer.from('found'))
        state.buffer = Buffer.alloc(state.end)
        state.buffer[state.start++] = 0x13
        state.buffer[state.start++] = 17
        c.uint16.encode(state, c.decode(c.uint16, packet.subarray(2, 4)))
        peer.ipv4.encode(state, { host: remote.address, port: remote.port })
        c.fixed32.encode(state, peer.id('127.0.0.1', socket.address().port))
        c.buffer.encode(state, Buffer.from('found'))
        socket.send(state.buffer, remote.port, remote.address)
      })
      await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    }
    const binary = process.env.FRONTIER_BIN || path.join(__dirname, '../build/query-frontier')
    const result = await new Promise((resolve, reject) => {
      const child = spawn(binary, sockets.map(s => String(s.address().port)), {
        env: { ...process.env, QUERY_EARLY: '1' }
      })
      let output = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Early completion timed out')) }, 6000)
      child.stdout.on('data', b => { output += b })
      child.stderr.on('data', b => { output += b })
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    assert.equal(result.code, 0, result.output)
    assert.equal(silentPackets, 2, 'only the two initial concurrent silent requests; no retries after completion')
  } finally {
    for (const socket of sockets) socket.close()
  }
})
