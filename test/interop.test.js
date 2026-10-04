'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const DHT = require('hyperdht')
const { EventEmitter } = require('node:events')
const UDX = require('udx-native')
const root = path.resolve(__dirname, '..')
const executable = process.env.ESPRUINO_BIN || path.join(root, 'build/espruino')
const moduleSource = fs.readFileSync(path.join(root, 'modules/HyperDHT.js'), 'utf8')
// Optional fixture adapter for sandboxes without interface-change/netlink access.
// Real UDX sockets, DHT RPC, Noise and encrypted streams are still used.
function makeUDX () {
  if (!process.env.HYPERDHT_STATIC_INTERFACES) return undefined
  const udx = new UDX()
  const interfaces = [{ name: 'lo', host: '127.0.0.1', family: 4, internal: true }]
  udx.networkInterfaces = () => interfaces
  udx.watchNetworkInterfaces = () => {
    const watcher = new EventEmitter()
    watcher.interfaces = interfaces
    watcher.watch = watcher.unwatch = () => watcher
    watcher.destroy = async () => { watcher.emit('close') }
    watcher[Symbol.iterator] = () => interfaces[Symbol.iterator]()
    return watcher
  }
  return udx
}
async function createTestnet (count = 3) {
  const nodes = []
  let bootstrap = []
  for (let i = 0; i < count; i++) {
    const node = new DHT({ udx: makeUDX(), host: '127.0.0.1', ephemeral: false, firewalled: false, bootstrap })
    nodes.push(node)
    await node.fullyBootstrapped()
    if (!i) bootstrap = [{ host: '127.0.0.1', port: node.address().port }]
  }
  return {
    bootstrap,
    createNode (options = {}) {
      const node = new DHT({ udx: makeUDX(), host: '127.0.0.1', bootstrap, ...options })
      nodes.push(node)
      return node
    },
    async destroy () {
      for (const node of nodes) for (const server of node.listening) await server.close()
      for (const node of nodes.reverse()) await node.destroy()
    }
  }
}
function run (script, timeout = 25000, onOutput) {
  assert.ok(fs.existsSync(executable), 'Build native Espruino first: scripts/build-host.sh')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-e',
      'Modules.addCached("HyperDHT", function(){\n' + moduleSource + '\n});\n' + script],
    { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Espruino timeout\n' + output)) }, timeout)
    child.stdout.on('data', b => { output += b; if (onOutput) Promise.resolve(onOutput(output)).catch(err => { child.kill('SIGKILL'); reject(err) }) })
    child.stderr.on('data', b => { output += b })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (process.env.HDHT_AUDIT_LEAKS) console.log(output)
      if (process.env.HYPERDHT_MEMORY_REPORT) {
        const samples = [...output.matchAll(/MEMORY (\w+) live=(\d+) peak=(\d+)/g)]
        if (!samples.length) return reject(new Error('Build with HYPERDHT_MEMORY_AUDIT=1 to measure memory'))
        const limit = Number(process.env.HYPERDHT_MEMORY_LIMIT || 98304)
        for (const m of samples) {
          if (+m[3] > limit) return reject(new Error('Native requested heap exceeded ' + limit + ': ' + m[0]))
          if (m[1] === 'destroyed' && +m[2] !== 0) return reject(new Error('Native allocation leak: ' + m[0]))
        }
        for (const line of output.split(/\r?\n/)) if (line.startsWith('MEMORY ')) console.log(line)
      }
      if (code !== 0 || !output.includes('INTEROP_OK') || /FAIL|Uncaught|ASSERT/i.test(output)) {
        reject(new Error('Espruino exit ' + code + '\n' + output))
      } else resolve(output)
    })
  })
}
test('actual Espruino native client exchanges all byte values with original HyperDHT', { timeout: 40000 }, async () => {
  const net = await createTestnet(3)
  try {
    const node = net.createNode()
    const seed = Buffer.alloc(32, 0x42)
    const expectedClientKey = DHT.keyPair(seed).publicKey.toString('hex')
    let connections = 0
    const server = node.createServer(socket => {
      connections++
      assert.equal(socket.remotePublicKey.toString('hex'), expectedClientKey, 'Noise client identity')
      socket.on('error', () => {})
      socket.pipe(socket)
    })
    const pair = DHT.keyPair()
    await server.listen(pair)
    const bootstrap = net.bootstrap[0].host + ':' + net.bootstrap[0].port
    const output = await run(`
var DHT = require("HyperDHT");
function check(ok, message) { if (!ok) { console.log("FAIL", message); throw new Error(message); } }
function rejects(fn) { var caught = false; try { fn(); } catch(e) { caught = true; } check(caught, "expected rejection"); }
var node = new DHT({bootstrap:${JSON.stringify(bootstrap)},seed:${JSON.stringify(seed.toString('hex'))}});
check(node.publicKey === ${JSON.stringify(expectedClientKey)}, "key derivation");
rejects(function(){ new DHT(); });
node.on("error", function(e){ console.log("FAIL", e); node.destroy(); });
var rounds = 0;
function connect() {
  rejects(function(){ node.connect("bad-key"); });
  var socket = node.connect(${JSON.stringify(pair.publicKey.toString('hex'))});
  var total = 32769, sent = 0, got = 0;
  rejects(function(){ socket.write("before open"); });
  function send() {
    if (sent >= total) return;
    var len = Math.min(1024, total - sent), data = "";
    for (var i = 0; i < len; i++) data += String.fromCharCode((sent+i) % 256);
    check(socket.write(data), "first write accepted");
    check(!socket.write("should not be accepted"), "backpressure refuses second write");
    sent += len;
  }
  socket.on("open", function(){
    rejects(function(){ socket.write(new Uint8Array(2)); });
    rejects(function(){ socket.write(""); });
    rejects(function(){ socket.write(new Array(1026).join("x")); });
    send();
  });
  socket.on("drain", send);
  socket.on("data", function(data){
    for (var i = 0; i < data.length; i++) check(data.charCodeAt(i) === ((got+i)%256), "binary byte " + (got+i));
    got += data.length;
    check(got <= total, "no duplication");
    if (got === total) socket.close();
  });
  socket.on("close", function(){
    check(got === total, "no truncation");
    rounds++;
    if (rounds === 3) node.destroy();
    else setTimeout(connect, 20);
  });
}
node.on("ready", connect);
node.on("close", function(){
  check(rounds === 3, "three reconnects");
  console.log("INTEROP_OK: 3 x 32769 binary bytes, key identity, backpressure, teardown");
});
`)
    assert.equal(connections, 3)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally {
    await net.destroy()
  }
})
test('bootstrap timeout destroys the client and permits a new instance', { timeout: 10000 }, async () => {
  const output = await run(`
var DHT = require("HyperDHT");
var failures = 0, rounds = 0;
function start() {
  var dht = new DHT({bootstrap:"127.0.0.1:9",bootstrapTimeout:100});
  dht.on("error", function(){ failures++; });
  dht.on("close", function(){
    rounds++;
    if (rounds < 2) start();
    else if (failures === 2) console.log("INTEROP_OK: timeout/recreate");
    else console.log("FAIL: expected two timeouts", failures);
  });
}
start();
`, 7000)
  console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
})
test('maximum sensor frame is delivered in bounded chunks and peer close is handled', { timeout: 30000 }, async () => {
  const net = await createTestnet()
  try {
    const node = net.createNode()
    const server = node.createServer(socket => {
      socket.on('error', () => {})
      const payload = Buffer.alloc(4096)
      for (let i = 0; i < payload.length; i++) payload[i] = i % 256
      socket.write(payload)
      socket.on('data', data => {
        assert.equal(data.toString(), 'ack')
        socket.end()
      })
    })
    const kp = DHT.keyPair()
    await server.listen(kp)
    const bootstrap = net.bootstrap[0].host + ':' + net.bootstrap[0].port
    const output = await run(`
var DHT = require("HyperDHT");
var d = new DHT({bootstrap:${JSON.stringify(bootstrap)}});
var got = 0;
d.on("error",function(e){ console.log("FAIL", e); d.destroy(); });
d.on("ready",function(){
  var s = d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
  s.on("data",function(data){
    if (data.length > 256) throw new Error("FAIL: receive chunk exceeds cap");
    for (var i=0;i<data.length;i++) if(data.charCodeAt(i)!==((got+i)%256)) throw new Error("FAIL: byte mismatch");
    got += data.length;
    if (got === 4096) s.write("ack");
  });
  s.on("close",function(){ d.destroy(); });
});
d.on("close",function(){ if(got===4096) console.log("INTEROP_OK: 4KiB peer write and remote close"); else console.log("FAIL",got); });
`)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})
test('cancel a pending connection, then construct another client', { timeout: 20000 }, async () => {
  const net = await createTestnet()
  try {
    const bootstrap = net.bootstrap[0].host + ':' + net.bootstrap[0].port
    const absentKey = DHT.keyPair().publicKey.toString('hex')
    const output = await run(`
var DHT = require("HyperDHT");
var round=0;
function start(){
  var d = new DHT({bootstrap:${JSON.stringify(bootstrap)},connectTimeout:100});
  d.on("ready",function(){ d.connect(${JSON.stringify(absentKey)}); d.destroy(); });
  d.on("error",function(e){ console.log("FAIL", e); });
  d.on("close",function(){
    round++;
    if(round<2) start();
    else console.log("INTEROP_OK: cancelled connect and recreate");
  });
}
start();
`, 15000)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})
test('destroy aborts an open stream without waiting for peer shutdown', { timeout: 20000 }, async () => {
  const net = await createTestnet()
  try {
    const peer = net.createNode()
    const server = peer.createServer(socket => { socket.on('error', () => {}) })
    const kp = DHT.keyPair()
    await server.listen(kp)
    const bootstrap = net.bootstrap[0].host + ':' + net.bootstrap[0].port
    const output = await run(`
var DHT=require("HyperDHT");
var opened=0,closed=0;
function start(){
  var d=new DHT({bootstrap:${JSON.stringify(bootstrap)}});
  d.on("error",function(e){ console.log("FAIL",e); d.destroy(); });
  d.on("ready",function(){
    var s=d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
    s.on("open",function(){opened++;d.destroy();});
    s.on("close",function(){closed++;});
  });
  d.on("close",function(){
    if(opened<20) start();
    else if(closed===20) console.log("INTEROP_OK: 20 active stream abort/recreate cycles");
    else console.log("FAIL",closed);
  });
}
start();
`, 15000)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})

test('oversized authenticated peer frame is rejected and client closes cleanly', { timeout: 15000 }, async () => {
  const net = await createTestnet()
  try {
    const peer = net.createNode()
    const server = peer.createServer(socket => {
      socket.on('error', () => {})
      socket.write(Buffer.alloc(4097, 7))
    })
    const kp = DHT.keyPair()
    await server.listen(kp)
    const output = await run(`
var DHT=require("HyperDHT"), errors=0, received=0;
var d=new DHT({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}});
d.on("error",function(e){if(e.code!==-9) console.log("FAIL",e); errors++;});
d.on("ready",function(){
 var s=d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
 s.on("data",function(data){received+=data.length;});
 s.on("close",function(){d.destroy();});
});
d.on("close",function(){
 if(errors===1 && received===0) console.log("INTEROP_OK: oversized frame rejected before delivery");
 else console.log("FAIL",errors,received);
});
`)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})

test('sensor stream negotiates hole punching with an original HyperDHT server', { timeout: 30000 }, async () => {
  const net = await createTestnet(6)
  try {
    // Force the non-public-server path and omit LAN shortcut addresses.
    // Real protocol negotiation on loopback; this is NOT a physical NAT test.
    const peer = net.createNode({ ephemeral: true, firewalled: true, quickFirewall: false })
    let punches = 0
    const server = peer.createServer({
      shareLocalAddress: false,
      holepunch () { return true }
    }, socket => {
      socket.on('error', () => {})
      socket.pipe(socket)
    })
    // Observe real relayed holepunch RPCs, including the fast-open path which
    // can succeed before the later user policy callback is needed.
    const onPunch = server._onpeerholepunch
    server._onpeerholepunch = function (...args) { punches++; return onPunch.apply(this, args) }
    const kp = DHT.keyPair()
    await server.listen(kp)
    assert.equal(peer.firewalled, true)
    const output = await run(`
var DHT=require("HyperDHT");
var d=new DHT({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)},connectTimeout:18000});
var got="",payload='{"sensor":"temperature","value":26.5}';
d.on("error",function(e){console.log("FAIL",e);d.destroy();});
d.on("ready",function(){
 var s=d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
 s.on("open",function(){s.write(payload);});
 s.on("data",function(data){got+=data;if(got.length>=payload.length)s.close();});
 s.on("close",function(){d.destroy();});
});
d.on("close",function(){if(got===payload)console.log("INTEROP_OK: sensor data after holepunch negotiation");else console.log("FAIL",got);});
`, 24000)
    assert.ok(punches > 0, 'server must receive a relayed holepunch RPC')
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})

test('bounded receive window survives a 64 KiB burst of small frames', { timeout: 20000 }, async () => {
  const net = await createTestnet()
  try {
    const peer = net.createNode()
    const server = peer.createServer(socket => {
      socket.on('error', () => {})
      let frame = 0
      function pump () {
        while (frame < 64) {
          const bytes = Buffer.alloc(1024, frame++)
          if (!socket.write(bytes)) return
        }
        socket.end()
      }
      socket.on('drain', pump)
      pump()
    })
    const kp = DHT.keyPair()
    await server.listen(kp)
    const output = await run(`
var DHT=require("HyperDHT"),count=0,bad=false;
var d=new DHT({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}});
d.on("error",function(e){console.log("FAIL",e);d.destroy();});
d.on("ready",function(){
 var s=d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
 s.on("data",function(b){for(var i=0;i<b.length;i++){if(b.charCodeAt(i)!==Math.floor(count/1024))bad=true;count++;}});
 s.on("close",function(){d.destroy();});
});
d.on("close",function(){if(count===65536&&!bad)console.log("INTEROP_OK: bounded burst intact");else console.log("FAIL",count,bad);});
`, 15000)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})

test('modified ciphertext is rejected before any plaintext is delivered', { timeout: 15000 }, async () => {
  const net = await createTestnet()
  try {
    const peer = net.createNode()
    const server = peer.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        const raw = socket.rawStream
        const original = raw.write
        raw.write = function (bytes, ...args) {
          raw.write = original
          const damaged = Buffer.from(bytes)
          damaged[damaged.length - 1] ^= 1
          return original.call(this, damaged, ...args)
        }
        socket.write(Buffer.from('authenticated sensor reply'))
      })
    })
    const kp = DHT.keyPair()
    await server.listen(kp)
    const output = await run(`
var DHT=require("HyperDHT"),errors=0,received=0;
var d=new DHT({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}});
d.on("error",function(e){if(e.code!==-12)console.log("FAIL",e);errors++;});
d.on("ready",function(){
 var s=d.connect(${JSON.stringify(kp.publicKey.toString('hex'))});
 s.on("open",function(){s.write("ready");});
 s.on("data",function(b){received+=b.length;});
 s.on("close",function(){d.destroy();});
});
d.on("close",function(){if(errors===1&&received===0)console.log("INTEROP_OK: invalid MAC rejected");else console.log("FAIL",errors,received);});
`)
    console.log(output.match(/INTEROP_OK[^\r\n]*/)[0])
  } finally { await net.destroy() }
})

test('Espruino server accepts authorized commands and reuses its listener', { timeout: 50000 }, async () => {
  const net = await createTestnet(6)
  const keyPair = DHT.keyPair()
  const seed = Buffer.alloc(32, 0x73)
  const serverKey = DHT.keyPair(seed).publicKey
  const client = net.createNode({ keyPair, firewalled: true })
  let punches = 0
  const punch = client._router.peerHolepunch
  client._router.peerHolepunch = function (...args) { punches++; return punch.apply(this, args) }
  let started = false
  let rounds = 0
  const sockets = []
  try {
    await run(`
var DHT = require("HyperDHT");
var node = new DHT({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)},seed:${JSON.stringify(seed.toString('hex'))}});
var rounds = 0;
node.on("error", function(e){ console.log("FAIL", e); node.destroy(); });
node.on("ready", function(){ node.listen(${JSON.stringify(keyPair.publicKey.toString('hex'))}); });
node.on("listening", function(){ console.log("SERVER_LISTENING"); });
node.on("connection", function(s){
  if (s.remotePublicKey !== ${JSON.stringify(keyPair.publicKey.toString('hex'))}) throw new Error("FAIL identity");
  var input = "";
  s.on("data", function(data){
    input += data;
    if (input === "read\\n") s.write("temperature=23\\n");
  });
  s.on("close", function(){
    rounds++;
    if (rounds === 3) node.destroy();
    else console.log("SERVER_NEXT");
  });
});
node.on("close", function(){ if(rounds !== 3) throw new Error("FAIL rounds"); console.log("INTEROP_OK"); });
`, 40000, async output => {
      const count = (output.match(/SERVER_NEXT/g) || []).length
      if (!output.includes('SERVER_LISTENING') || (started && count < rounds)) return
      started = true
      rounds++
      const socket = client.connect(serverKey, { shareLocalAddress: false })
      sockets.push(socket)
      await new Promise((resolve, reject) => {
        let reply = ''
        socket.on('error', reject)
        socket.on('open', () => socket.write('read\n'))
        socket.on('data', data => {
          reply += data.toString()
          if (reply.endsWith('\n')) {
            assert.equal(reply, 'temperature=23\n')
            socket.end()
          }
        })
        socket.on('close', () => { assert.equal(reply, 'temperature=23\n'); resolve() })
      })
    })
    assert.equal(rounds, 3)
    assert.ok(punches > 0, 'incoming sessions must negotiate holepunch RPCs')
  } finally {
    for (const socket of sockets) socket.destroy()
    await net.destroy()
  }
})

test('Espruino listener rejects unknown keys and busy peers without losing the active stream', { timeout: 40000 }, async () => {
  const net = await createTestnet()
  const pair = DHT.keyPair()
  const seed = Buffer.alloc(32, 0x74)
  const serverKey = DHT.keyPair(seed).publicKey
  const client = net.createNode({ keyPair: pair })
  const stranger = net.createNode()
  const sockets = []
  let started = false
  try {
    await run(`
var node = new (require("HyperDHT"))({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}, seed:${JSON.stringify(seed.toString('hex'))}});
var count = 0;
node.on("ready", function(){ node.listen(${JSON.stringify(pair.publicKey.toString('hex'))}); });
node.on("listening", function(){ console.log("SERVER_LISTENING"); });
node.on("error", function(e){ console.log("FAIL", e); node.destroy(); });
node.on("connection", function(s){
  count++;
  if(count !== 1) throw new Error("FAIL excess connection");
  s.on("data", function(data){ if (data === "finish") s.write("ok"); });
  s.on("close", function(){ node.destroy(); });
});
node.on("close", function(){ console.log(count === 1 ? "INTEROP_OK" : "FAIL no connection"); });
`, 30000, async output => {
      if (started || !output.includes('SERVER_LISTENING')) return
      started = true
      let unwanted = false
      const denied = stranger.connect(serverKey)
      sockets.push(denied)
      denied.on('error', () => {})
      denied.on('open', () => { unwanted = true })
      // Give the denied handshake time to arrive before an authorized attempt.
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(unwanted, false)
      denied.destroy()
      const active = client.connect(serverKey)
      sockets.push(active)
      await new Promise((resolve, reject) => { active.on('error', reject); active.on('open', resolve) })
      const busy = client.connect(serverKey)
      sockets.push(busy)
      busy.on('error', () => {})
      busy.on('open', () => { unwanted = true })
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(unwanted, false)
      busy.destroy()
      await new Promise((resolve, reject) => {
        active.on('error', reject)
        active.on('data', data => {
          try { assert.equal(data.toString(), 'ok'); active.end(); resolve() } catch (err) { reject(err) }
        })
        active.write('finish')
      })
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    await net.destroy()
  }
})

test('Espruino listening nodes repeatedly destroy and restart without native leaks', { timeout: 40000 }, async () => {
  const net = await createTestnet()
  const key = DHT.keyPair().publicKey.toString('hex')
  try {
    await run(`
var rounds = 0;
function start() {
  var d = new (require("HyperDHT"))({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}});
  d.on("error", function(e){ console.log("FAIL", e); d.destroy(); });
  d.on("ready", function(){ d.listen(${JSON.stringify(key)}); });
  d.on("listening", function(){ d.destroy(); });
  d.on("close", function(){ if (++rounds === 3) console.log("INTEROP_OK"); else start(); });
}
start();
`)
  } finally { await net.destroy() }
})

test('Espruino destroys a listener with an active inbound stream', { timeout: 30000 }, async () => {
  const net = await createTestnet()
  const pair = DHT.keyPair()
  const seed = Buffer.alloc(32, 0x75)
  const client = net.createNode({ keyPair: pair })
  let socket, started = false
  try {
    await run(`
var node = new (require("HyperDHT"))({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)},seed:${JSON.stringify(seed.toString('hex'))}});
var accepted = false;
node.on("ready", function(){ node.listen(${JSON.stringify(pair.publicKey.toString('hex'))}); });
node.on("listening", function(){ console.log("SERVER_LISTENING"); });
node.on("connection", function(s){ accepted = true; node.destroy(); });
node.on("close", function(){ console.log(accepted ? "INTEROP_OK" : "FAIL"); });
`, 25000, output => {
      if (started || !output.includes('SERVER_LISTENING')) return
      started = true
      socket = client.connect(DHT.keyPair(seed).publicKey)
      socket.on('error', () => {})
    })
  } finally {
    if (socket) socket.destroy()
    await net.destroy()
  }
})

test('Espruino cancels an announcement before listener readiness', { timeout: 15000 }, async () => {
  const net = await createTestnet()
  try {
    await run(`
var node = new (require("HyperDHT"))({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}});
node.on("ready", function(){ node.listen(${JSON.stringify(DHT.keyPair().publicKey.toString('hex'))}); node.destroy(); });
node.on("listening", function(){ throw new Error("FAIL late listening event"); });
node.on("close", function(){ console.log("INTEROP_OK"); });
`, 10000)
  } finally { await net.destroy() }
})

test('native parallel relay attempts reuse one Noise request and server session', { timeout: 40000 }, async () => {
  const net = await createTestnet(6)
  try {
    const peer = net.createNode()
    let connections = 0
    const requests = []
    const server = peer.createServer(socket => {
      connections++
      socket.on('error', () => {})
      socket.pipe(socket)
    })
    const onHandshake = server._onpeerhandshake
    server._onpeerhandshake = async function (message, request) {
      requests.push(message.noise.toString('hex'))
      // Hold replies until the second advertised relay can be tried.
      await new Promise(resolve => setTimeout(resolve, 250))
      return onHandshake.call(this, message, request)
    }
    await server.listen()
    const bootstrap = net.bootstrap[0].host + ':' + net.bootstrap[0].port
    await run(`
var d = new (require("HyperDHT"))({bootstrap:${JSON.stringify(bootstrap)}});
d.on("error",function(e){console.log("FAIL",e);d.destroy();});
d.on("ready",function(){
  var s=d.connect(${JSON.stringify(server.publicKey.toString('hex'))});
  s.on("error",function(e){console.log("FAIL",e);d.destroy();});
  s.on("open",function(){s.write("shared handshake");});
  s.on("data",function(b){if(b!=="shared handshake")console.log("FAIL",b);s.close();});
  s.on("close",function(){d.destroy();});
});
d.on("close",function(){console.log("INTEROP_OK: parallel relay echo");});
`)
    assert.ok(requests.length >= 2, 'exercise competing relay requests')
    assert.equal(new Set(requests).size, 1, 'all relays receive the identical Noise request')
    assert.equal(connections, 1, 'the server creates one encrypted session')
  } finally {
    await net.destroy()
  }
})

test('native client completes twenty consecutive firewalled-peer reconnects', { timeout: 90000 }, async () => {
  const net = await createTestnet(6)
  try {
    const peer = net.createNode({ ephemeral: true, firewalled: true, quickFirewall: false })
    let connections = 0
    const server = peer.createServer({ shareLocalAddress: false, holepunch: () => true }, socket => {
      connections++
      socket.on('error', () => {})
      socket.pipe(socket)
    })
    await server.listen()
    await run(`
var d=new(require("HyperDHT"))({bootstrap:${JSON.stringify(net.bootstrap[0].host + ':' + net.bootstrap[0].port)}}),round=0;
d.on("error",function(e){console.log("FAIL",e);d.destroy();});
function connect(){
 var s=d.connect(${JSON.stringify(server.publicKey.toString('hex'))}),received="",expected="";
 for(var i=0;i<1024;i++)expected+=String.fromCharCode(i%256);
 s.on("open",function(){s.write(expected);});
 s.on("data",function(b){received+=b;if(received.length>=expected.length){if(received!==expected){console.log("FAIL bytes",round);d.destroy();}else{round++;s.close();}}});
 s.on("close",function(){if(round===20)d.destroy();else setTimeout(connect,100);});
}
d.on("ready",connect);
d.on("close",function(){if(round===20)console.log("INTEROP_OK: twenty firewalled reconnects");else console.log("FAIL rounds",round);});
`, 80000)
    assert.equal(connections, 20)
  } finally { await net.destroy() }
})
