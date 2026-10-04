#!/usr/bin/env python3
"""Upload a RAM-only binary echo test; credentials never appear in output."""
import argparse
import json
from pathlib import Path
import re
import sys
import time
import serial

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', required=True)
parser.add_argument('--wifi', type=Path, required=True, help='JSON with ssid/password')
parser.add_argument('--key', required=True, help='Echo server public key, 64 hex')
parser.add_argument('--bootstrap', help='IPv4:port; omit for the public DHT')
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--log', type=Path, default=Path('out/c6-hardware-echo.log'))
args = parser.parse_args()
if not re.fullmatch(r'[0-9a-fA-F]{64}', args.key) or not 1 <= args.rounds <= 20:
    parser.error('Expected a 64 hex key and 1..20 rounds')
root = Path(__file__).resolve().parents[1]
credentials = json.loads(args.wifi.read_text())
secrets = [credentials['ssid'], credentials['password']]
options = {'bootstrapTimeout': 180000, 'connectTimeout': 90000}
if args.bootstrap:
    options['bootstrap'] = args.bootstrap

program = r'''
require("Wifi").connect(SSID,{password:PASS},function(e){
 if(e){print("TEST_FAIL_WIFI",e);return;}
 var w=require("Wifi"),before=w.getStatus().powersave;
 print("WIFI_OK",w.getIP().ip,"POWER_BEFORE",before);
 var d=new (require("HyperDHT"))(OPTIONS),round=0,failed=false;
 print("POWER_ACTIVE",w.getStatus().powersave,"HEAP",ESP32.getState().freeHeap);
 d.on("error",function(e){failed=true;print("TEST_FAIL",e);d.destroy();});
 d.on("close",function(){
  print("POWER_RESTORED",w.getStatus().powersave,"HEAP",ESP32.getState().freeHeap);
  if(w.getStatus().powersave!==before){failed=true;print("TEST_FAIL_POWER");}
  print(!failed&&round===ROUNDS?"TEST_OK":"TEST_FAILED",round);
 });
 function connect(){
  var expected="",received="",s=d.connect(KEY);
  for(var i=0;i<1024;i++)expected+=String.fromCharCode(i%256);
  s.on("open",function(){print("STREAM_OPEN",round+1);s.write(expected);});
  s.on("data",function(chunk){
   received+=chunk;
   if(received.length>=expected.length){
    if(received!==expected){failed=true;print("TEST_FAIL_BYTES");d.destroy();}
    else{round++;print("ECHO_OK",round,received.length,"HEAP",ESP32.getState().freeHeap);s.close();}
   }
  });
  s.on("close",function(){
   if(failed||round===ROUNDS)d.destroy();else setTimeout(connect,100);
  });
 }
 d.on("ready",function(){print("DHT_READY");connect();});
});
'''
for name, value in [('SSID', credentials['ssid']), ('PASS', credentials['password']),
                    ('OPTIONS', options), ('ROUNDS', args.rounds), ('KEY', args.key)]:
    program = program.replace(name, json.dumps(value))
log = bytearray()

def clean():
    result = log.decode('utf-8', 'replace')
    for secret in secrets:
        if secret:
            result = result.replace(secret, '[REDACTED]')
    return result

with serial.Serial(args.port, 115200, timeout=.1, write_timeout=2) as connection:
    connection.dtr = False
    connection.rts = False

    def capture(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            log.extend(connection.read(4096))

    def send(code):
        data = b'\x10' + code.encode() + b'\n'
        for offset in range(0, len(data), 96):
            connection.write(data[offset:offset + 96])
            time.sleep(.03)
            log.extend(connection.read(4096))

    capture(3)
    connection.write(b'\x03\n')
    capture(.3)
    send('echo(0);var __src="";')
    source = (root / 'modules/HyperDHT.js').read_text()
    for i in range(0, len(source), 300):
        send('__src+=' + json.dumps(source[i:i+300]) + ';')
    send('Modules.addCached("HyperDHT",__src);__src=undefined;')
    send(''.join(line.strip() for line in program.splitlines()))
    deadline = time.monotonic() + 210 + args.rounds * 100
    shown = 0
    while time.monotonic() < deadline:
        capture(1)
        output = clean()
        print(output[shown:], end='', flush=True)
        shown = len(output)
        if any(marker in output for marker in ('TEST_OK', 'TEST_FAILED', 'TEST_FAIL_WIFI', 'Uncaught', 'Guru Meditation', 'abort() was called')):
            break
    else:
        send('require("HyperDHTNative").destroy();')
        capture(3)
        log.extend(b'\nTEST_FAIL_HOST_TIMEOUT\n')
args.log.parent.mkdir(parents=True, exist_ok=True)
args.log.write_text(clean())
sys.exit(0 if 'TEST_OK' in clean() and 'TEST_FAIL' not in clean() else 1)
