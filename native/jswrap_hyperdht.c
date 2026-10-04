/* Native module for Espruino's generated-wrapper mechanism. */
#include "jswrap_hyperdht.h"
#include "jsparse.h"
#include "client.h"
#include <string.h>
/*JSON{
  "type": "library",
  "class": "HyperDHTNative"
}*/
static int unhex(JsVar *v, uint8_t out[32]) {
  char s[65];
  if (!jsvIsString(v) || jsvGetStringLength(v) != 64) return 0;
  jsvGetString(v, s, sizeof(s));
  for (int i = 0; i < 32; i++) {
    int value = 0;
    for (int j = 0; j < 2; j++) {
      char ch = s[2*i+j];
      int n = ch >= '0' && ch <= '9' ? ch-'0' :
              ch >= 'a' && ch <= 'f' ? ch-'a'+10 :
              ch >= 'A' && ch <= 'F' ? ch-'A'+10 : -1;
      if (n < 0) return 0;
      value = value*16+n;
    }
    out[i] = value;
  }
  return 1;
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "start",
  "generate": "jswrap_hyperdht_start",
  "params": [
    [
      "bootstrap",
      "JsVar",
      "Optional IPv4:port"
    ],
    [
      "seed",
      "JsVar",
      "Optional 64 hex seed"
    ]
  ],
  "return": [
    "JsVar",
    "Public key hex"
  ]
}*/
JsVar *jswrap_hyperdht_start(JsVar *bootstrap, JsVar *seed) {
  char address[128] = {0}, hex[65]; uint8_t raw[32];
  if (!jsvIsUndefined(bootstrap)) {
    if (!jsvIsString(bootstrap) || jsvGetStringLength(bootstrap) >= sizeof(address)) {
      jsExceptionHere(JSET_TYPEERROR, "Invalid bootstrap"); return NULL;
    }
    jsvGetString(bootstrap, address, sizeof(address));
  }
  int seeded = !jsvIsUndefined(seed);
  if (seeded && !unhex(seed, raw)) { jsExceptionHere(JSET_TYPEERROR, "Expected 64 hex seed"); return NULL; }
  int rc = hdht_start(address, seeded ? raw : NULL);
  volatile uint8_t *wipe = raw;
  for (int i = 0; i < 32; i++) wipe[i] = 0;
  if (rc) { jsExceptionHere(JSET_ERROR, "HyperDHT start: %d", rc); return NULL; }
  hdht_public_key(raw);
  const char *digits = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { hex[2*i] = digits[raw[i] >> 4]; hex[2*i+1] = digits[raw[i] & 15]; }
  hex[64] = 0;
  return jsvNewFromString(hex);
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "connect",
  "generate": "jswrap_hyperdht_connect",
  "params": [
    [
      "key",
      "JsVar",
      "64 hex public key"
    ]
  ],
  "return": [
    "int",
    "Status"
  ]
}*/
int jswrap_hyperdht_connect(JsVar *key) {
  uint8_t raw[32];
  if (!unhex(key, raw)) { jsExceptionHere(JSET_TYPEERROR, "Expected 64 hex public key"); return -1; }
  return hdht_connect(raw);
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "listen",
  "generate": "jswrap_hyperdht_listen",
  "params": [["key", "JsVar", "Authorized peer public key: 64 hex"]],
  "return": ["int", "Status"]
}*/
int jswrap_hyperdht_listen(JsVar *key) {
  uint8_t raw[32];
  if (!unhex(key, raw)) { jsExceptionHere(JSET_TYPEERROR, "Expected 64 hex public key"); return -1; }
  return hdht_listen(raw);
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "write",
  "generate": "jswrap_hyperdht_write",
  "params": [
    [
      "data",
      "JsVar",
      "Binary string, 1..1024 bytes"
    ]
  ],
  "return": [
    "int",
    "0 accepted, 1 busy, negative error"
  ]
}*/
int jswrap_hyperdht_write(JsVar *data) {
  if (!jsvIsString(data)) { jsExceptionHere(JSET_TYPEERROR, "Expected binary string"); return -1; }
  size_t len = jsvGetStringLength(data);
  if (!len || len > HDHT_WRITE_MAX) { jsExceptionHere(JSET_ERROR, "Write requires 1..1024 bytes"); return -1; }
  uint8_t bytes[HDHT_WRITE_MAX];
  jsvGetStringChars(data, 0, (char *)bytes, len);
  return hdht_write(bytes, len);
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "poll",
  "generate": "jswrap_hyperdht_poll",
  "return": [
    "JsVar",
    "Next event or undefined"
  ]
}*/
JsVar *jswrap_hyperdht_poll(void) {
  hdht_tick();
  const uint8_t *bytes; size_t len; int code;
  const char *type = hdht_event(&bytes, &len, &code);
  if (!type) return NULL;
  JsVar *o = jsvNewObject();
  if (!o) return NULL;
  jsvObjectSetChildAndUnLock(o, "type", jsvNewFromString(type));
  if (bytes) {
    JsVar *s = jsvNewStringOfLength((unsigned int)len, (const char *)bytes);
    if (!s) { jsvUnLock(o); return NULL; }
    jsvObjectSetChildAndUnLock(o, "data", s);
  }
  if (code) jsvObjectSetChildAndUnLock(o, "code", jsvNewFromInteger(code));
  hdht_consume(len);
  return o;
}
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "close",
  "generate": "jswrap_hyperdht_close"
}*/
void jswrap_hyperdht_close(void) { hdht_close(); }
/*JSON{
  "type": "staticmethod",
  "class": "HyperDHTNative",
  "name": "destroy",
  "generate": "jswrap_hyperdht_destroy"
}*/
void jswrap_hyperdht_destroy(void) { hdht_destroy(); }
/*JSON{
  "type": "kill",
  "generate": "jswrap_hyperdht_kill"
}*/
void jswrap_hyperdht_kill(void) { hdht_shutdown(); }
