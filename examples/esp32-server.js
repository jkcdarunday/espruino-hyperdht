// Load modules/HyperDHT.js into Espruino's module cache first.
// Provision a private random seed per device. Configure WiFi below.
var WIFI_SSID = "YOUR_WIFI";
var WIFI_PASSWORD = "YOUR_PASSWORD";
var node;
var DEVICE_SEED = "REPLACE_WITH_64_HEX_SEED";
var CONTROLLER_KEY = "REPLACE_WITH_CONTROLLER_PUBLIC_KEY";
// Replace the sample response with your sensor reading.
function startServer() {
node = new (require("HyperDHT"))({seed: DEVICE_SEED});
node.on("ready", function () { node.listen(CONTROLLER_KEY); });
node.on("listening", function () { console.log("Device key:", node.publicKey); });
node.on("error", function (err) { console.log(err); });
node.on("connection", function (socket) {
  var input = "", pending = "";
  function flush() {
    if (pending && socket.writable && socket.write(pending)) pending = "";
  }
  socket.on("drain", flush);
  socket.on("data", function (data) {
    input += data;
    // One small command/reply at a time; bound application memory too.
    if (input.length > 128 || pending) { socket.close(); return; }
    var end = input.indexOf("\n");
    if (end < 0) return;
    var command = input.substring(0, end);
    input = input.substring(end + 1);
    if (input.length) { socket.close(); return; }
    pending = command === "status" ? '{"ok":true}\n' :
              command === "sample" ? JSON.stringify({uptime: getTime()}) + "\n" :
              '{"error":"unknown command"}\n';
    flush();
  });
});
// socket.close() closes a connection. node.destroy() also stops listening.

}
function onInit() {
  require("Wifi").connect(WIFI_SSID, {password: WIFI_PASSWORD}, function(err) {
    if (err) { console.log("WiFi error:", err); return; }
    startServer();
  });
}
onInit();
