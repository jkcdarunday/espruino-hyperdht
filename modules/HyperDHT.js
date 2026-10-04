/* Espruino module. The native firmware module owns protocol/crypto state. */
var native = require("HyperDHTNative");
var singleton;
function Emitter() { this._events = {}; }
Emitter.prototype.on = function (name, fn) {
  if (typeof fn !== "function") throw new Error("Listener must be a function");
  if (!this._events[name]) this._events[name] = [];
  this._events[name].push(fn);
  return this;
};
Emitter.prototype.emit = function (name, value) {
  var list = this._events[name];
  if (list) for (var i = 0; i < list.length; i++) list[i](value);
};
function Stream(node, key) {
  Emitter.call(this);
  this.node = node;
  this.remotePublicKey = key.toLowerCase();
  this.connected = false;
  this.closed = false;
  this.writable = false;
}
Stream.prototype = Object.create(Emitter.prototype);
Stream.prototype.write = function (bytes) {
  if (typeof bytes !== "string") throw new Error("Use a binary string (E.toString for Uint8Array)");
  if (!this.connected || this.closed) throw new Error("Stream is not open");
  if (!bytes.length || bytes.length > 1024) throw new Error("Write requires 1..1024 bytes");
  if (!this.writable) return false;
  var rc = native.write(bytes);
  if (rc < 0) throw new Error("HyperDHT write: " + rc);
  this.writable = false;
  return rc === 0; // true = accepted; false = NOT accepted; retry after drain
};
Stream.prototype.close = function () {
  if (this.closed) return;
  this.writable = false;
  this.node._deadline = Date.now() + 10000;
  native.close();
};
function DHT(options) {
  if (!(this instanceof DHT)) return new DHT(options);
  if (singleton) throw new Error("Only one HyperDHT node is supported");
  Emitter.call(this);
  options = options || {};
  if (options.bootstrap) {
    if (typeof options.bootstrap !== "string") throw new Error("bootstrap must be IPv4:port");
    var parts = options.bootstrap.split(":"), octets = parts[0].split(".");
    if (parts.length !== 2 || octets.length !== 4) throw new Error("bootstrap must be IPv4:port");
    for (var i = 0; i < 4; i++) {
      if (!octets[i].length || octets[i].length > 3 || !/^[0-9]+$/.test(octets[i]) || +octets[i] > 255) throw new Error("Invalid IPv4");
    }
    if (!/^[0-9]+$/.test(parts[1]) || +parts[1] < 1 || +parts[1] > 65535) throw new Error("Invalid port");
  }
  this.listening = false;
  this._listenRequested = false;
  this.ready = false;
  this.destroyed = false;
  this.destroying = false;
  this.stream = undefined;
  this.connectTimeout = options.connectTimeout || 45000;
  this.publicKey = native.start(options.bootstrap, options.seed);
  singleton = this;
  this._deadline = Date.now() + (options.bootstrapTimeout || 180000);
  var self = this;
  this._timer = setInterval(function () { self._poll(); }, 10);
}
DHT.prototype = Object.create(Emitter.prototype);
DHT.prototype.listen = function (allowedKey) {
  if (!this.ready || this.destroying || this.destroyed) throw new Error("Wait for ready");
  if (this._listenRequested || (this.stream && !this.stream.closed)) throw new Error("Node is busy");
  if (typeof allowedKey !== "string" || allowedKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(allowedKey)) throw new Error("Expected authorized 64 hex public key");
  var rc = native.listen(allowedKey);
  if (rc) throw new Error("HyperDHT listen: " + rc);
  this._listenRequested = true;
  this._deadline = Date.now() + this.connectTimeout;
  return this;
};
DHT.prototype.connect = function (key) {
  if (this._listenRequested) throw new Error("Node is listening");
  if (!this.ready || this.destroying || this.destroyed) throw new Error("Wait for ready");
  if (this.stream && !this.stream.closed) throw new Error("One connection at a time");
  if (typeof key !== "string" || (key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key))) throw new Error("Expected 64 hex public key");
  var rc = native.connect(key);
  if (rc) throw new Error("HyperDHT connect: " + rc);
  this.stream = new Stream(this, key);
  this._deadline = Date.now() + this.connectTimeout;
  return this.stream;
};
DHT.prototype.destroy = function () {
  if (this.destroying || this.destroyed) return;
  this.destroying = true;
  this.listening = false;
  this.ready = false;
  this._deadline = 0;
  if (this.stream) this.stream.writable = false;
  native.destroy();
};
DHT.prototype._closeStream = function () {
  var s = this.stream;
  this._deadline = 0;
  if (!s || s.closed) return;
  s.closed = true;
  s.connected = s.writable = false;
  s.emit("close");
};
DHT.prototype._poll = function () {
  if (this._deadline && Date.now() > this._deadline) {
    this.destroy();
    this.emit("error", new Error("HyperDHT operation timed out"));
  }
  for (var i = 0; i < 4; i++) {
    var event = native.poll();
    if (!event) break;
    var s = this.stream;
    if (event.type === "ready") {
      this.ready = true; this._deadline = 0; this.emit("ready");
    } else if (event.type === "listening") {
      this.listening = true; this._deadline = 0; this.emit("listening");
    } else if (event.type === "accepting") {
      this._deadline = Date.now() + this.connectTimeout;
    } else if (event.type === "connection") {
      this._deadline = 0;
      s = this.stream = new Stream(this, event.data);
      s.connected = s.writable = true;
      this.emit("connection", s);
    } else if (event.type === "open") {
      this._deadline = 0;
      if (s) { s.connected = s.writable = true; s.emit("open"); }
    } else if (event.type === "data") {
      if (s && !s.closed) s.emit("data", event.data);
    } else if (event.type === "drain") {
      if (s && !s.closed) { s.writable = true; s.emit("drain"); }
    } else if (event.type === "close") {
      this._closeStream();
    } else if (event.type === "error") {
      var err = new Error("HyperDHT native error: " + event.code);
      err.code = event.code;
      this.emit("error", err);
    } else if (event.type === "destroyed") {
      clearInterval(this._timer);
      this._timer = undefined;
      this.destroyed = true; this.destroying = false; this.ready = false;
      singleton = undefined;
      this._closeStream();
      this.emit("close");
      break;
    }
  }
};
exports = DHT;
