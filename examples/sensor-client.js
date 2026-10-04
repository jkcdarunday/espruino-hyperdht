/* Custom firmware required. ADC pin D0 is only a sample: adapt to your sensor. */
var WIFI_SSID = "YOUR_WIFI";
var WIFI_PASSWORD = "YOUR_PASSWORD";
var REMOTE_KEY = "REPLACE_WITH_64_HEX_CHARACTERS";
var client, stream, sampleTimer, retryTimer;
var sequence = 0, latest, response = "", retryMs = 1000;
function flushSample() {
  if (stream && stream.connected && stream.writable && latest) {
    if (stream.write(latest)) latest = undefined;
  }
}
function sample() {
  // Retain only the latest reading if the network is slower than the sensor.
  latest = JSON.stringify({seq:sequence++, adc:analogRead(D0)}) + "\n";
  flushSample();
}
function reconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(function () {
    retryTimer = undefined;
    require("Wifi").connect(WIFI_SSID, {password:WIFI_PASSWORD}, function (err) {
      if (err) { reconnect(); return; }
      startDHT();
    });
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 30000);
}
function startDHT() {
  if (client) return;
  response = "";
  try { client = new (require("HyperDHT"))(); }
  catch (e) { console.log(e); reconnect(); return; }
  client.on("error", function(e) { console.log(e); client.destroy(); });
  client.on("ready", function() {
    stream = client.connect(REMOTE_KEY);
    stream.on("open", function() { retryMs = 1000; flushSample(); });
    stream.on("drain", flushSample);
    stream.on("data", function(bytes) {
      // ACK lines are short. Reject a peer that grows the parser buffer.
      response += bytes;
      var end;
      while ((end = response.indexOf("\n")) >= 0) {
        if (end > 1024) { client.destroy(); return; }
        console.log("ACK", response.substr(0, end));
        response = response.substr(end + 1);
      }
      if (response.length > 1024) client.destroy();
    });
    stream.on("close", function() { client.destroy(); });
  });
  client.on("close", function() { client = stream = undefined; reconnect(); });
}
function onInit() {
  if (sampleTimer) return;
  if (!/^[0-9a-fA-F]{64}$/.test(REMOTE_KEY)) throw new Error("Set REMOTE_KEY first");
  require("Wifi").on("disconnected", function() { if (client) client.destroy(); });
  sample();
  sampleTimer = setInterval(sample, 10000);
  reconnect();
}
onInit();
// Save definitions only while stopped; onInit recreates all native handles.
