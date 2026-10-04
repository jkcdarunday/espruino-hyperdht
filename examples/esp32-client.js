/* Upload with Espruino Web IDE AFTER flashing the custom firmware.
 * Put modules/HyperDHT.js in the IDE sandbox's modules directory.
 * Set these three values. Public keys are hex strings, not Node Buffers. */
var WIFI_SSID = "YOUR_WIFI";
var WIFI_PASSWORD = "YOUR_PASSWORD";
var REMOTE_KEY = "REPLACE_WITH_64_HEX_CHARACTERS";
var client;
function onInit() {
  require("Wifi").connect(WIFI_SSID, { password: WIFI_PASSWORD }, function (err) {
    if (err) { console.log("WiFi error:", err); return; }
    var DHT = require("HyperDHT");
    client = new DHT(); // public HyperDHT network; fresh client identity each boot
    client.on("error", function (err) { console.log(err); });
    client.on("ready", function () {
      console.log("DHT ready:", client.publicKey);
      var stream = client.connect(REMOTE_KEY);
      var expected = "hello from Espruino on ESP32!\x00\xff\n";
      var received = "";
      stream.on("open", function () { stream.write(expected); });
      stream.on("data", function (chunk) {
        // A byte stream has arbitrary chunk boundaries. Accumulate this small echo.
        received += chunk;
        if (received.length >= expected.length) {
          console.log(received === expected ? "ECHO OK" : "ECHO MISMATCH");
          stream.close();
        }
      });
      stream.on("close", function () { client.destroy(); });
    });
    client.on("close", function () { console.log("DHT closed"); });
  });
}
onInit();
// For boot persistence, use the IDE's Save on Send -> Flash setting.
// Never call save() while a native DHT connection is running.
