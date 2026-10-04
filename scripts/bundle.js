'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const moduleSource = fs.readFileSync(path.join(root, 'modules/HyperDHT.js'), 'utf8')
fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
for (const name of ['esp32-client.js', 'sensor-client.js', 'esp32-server.js']) {
  const example = fs.readFileSync(path.join(root, 'examples', name), 'utf8')
  fs.writeFileSync(path.join(root, 'dist', name),
    'Modules.addCached("HyperDHT", function () {\n' + moduleSource + '\n});\n' + example)
  console.log('dist/' + name + ' (configure WiFi and peer/identity keys before upload)')
}
