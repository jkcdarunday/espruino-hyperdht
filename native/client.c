#include "client.h"
#include <hyperdht/hyperdht.h>
#include <uv.h>
#include <stdlib.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include <esp_wifi.h>
#endif

#ifdef HDHT_MEMORY_AUDIT
extern void hdht_audit_enter(void), hdht_audit_leave(void);
extern void hdht_audit_snapshot(const char *stage);
static void audit_leave(int *unused) { (void)unused; hdht_audit_leave(); }
#define AUDIT_SCOPE hdht_audit_enter(); int audit_guard __attribute__((cleanup(audit_leave))) = 0
#define AUDIT_SNAPSHOT(stage) hdht_audit_snapshot(stage)
#else
#define AUDIT_SCOPE
#define AUDIT_SNAPSHOT(stage)
#endif

/* One node/connection. Bound bridge memory independently of peer input. */
#define EVENTS 8
#define RX_LIMIT 4096
struct event { const char *type; uint8_t *data; size_t len, offset; int code; };
static struct {
  uv_loop_t loop;
  hyperdht_t *dht;
  hyperdht_stream_t *stream;
  hyperdht_server_t *server;
  uint8_t allowed_key[32];
  uint8_t remote_hex[64];
  struct event events[EVENTS];
  unsigned head, count;
  size_t rx_bytes;
  int initialized, ready, connecting, opened, writing, closing;
  int destroying, resume, fatal;
#ifdef ESP_PLATFORM
  wifi_ps_type_t saved_wifi_ps;
  int restore_wifi_ps;
#endif
} c;

/* Modem sleep caused persistent ERR_IF/ENOMEM sends on the physical C6.
 * Keep the radio awake for discovery and punch probes, then return ownership
 * of the power setting to the application when native teardown finishes. */
static int wifi_awake(void) {
#ifdef ESP_PLATFORM
  esp_err_t rc = esp_wifi_get_ps(&c.saved_wifi_ps);
  if (rc != ESP_OK) return -rc;
  if (c.saved_wifi_ps != WIFI_PS_NONE) {
    rc = esp_wifi_set_ps(WIFI_PS_NONE);
    if (rc != ESP_OK) return -rc;
    c.restore_wifi_ps = 1;
  }
#endif
  return 0;
}
static void wifi_restore(void) {
#ifdef ESP_PLATFORM
  if (c.restore_wifi_ps) {
    esp_wifi_set_ps(c.saved_wifi_ps);
    c.restore_wifi_ps = 0;
  }
#endif
}

static void push(const char *type, const uint8_t *data, size_t len, int code) {
  if (c.destroying) return;
  if (c.count == EVENTS || len > RX_LIMIT - c.rx_bytes) { c.fatal = -100; return; }
  struct event *e = &c.events[(c.head + c.count) % EVENTS];
  uint8_t *copy = NULL;
  if (len) {
    copy = malloc(len);
    if (!copy) { c.fatal = -101; return; }
    memcpy(copy, data, len);
  }
  *e = (struct event){type, copy, len, 0, code};
  c.rx_bytes += len;
  c.count++;
}
static void clear_events(void) {
  while (c.count) {
    c.rx_bytes -= c.events[c.head].len;
    free(c.events[c.head].data);
    memset(&c.events[c.head], 0, sizeof(struct event));
    c.head = (c.head + 1) % EVENTS;
    c.count--;
  }
}
static void bootstrapped(void *unused) {
  (void)unused;
  AUDIT_SNAPSHOT("ready");
  if (!c.ready) { c.ready = 1; push("ready", NULL, 0, 0); }
}
static void opened(void *unused) {
  (void)unused;
  AUDIT_SNAPSHOT("open");
  c.opened = 1;
  c.connecting = 0;
  if (c.server) push("connection", c.remote_hex, 64, 0);
  else push("open", NULL, 0, 0);
}
static void received(const uint8_t *data, size_t len, void *unused) {
  (void)unused;
  if (!len || c.destroying) return;
  if (c.stream) hyperdht_stream_pause(c.stream);
  push("data", data, len, 0);
}
static void closed(void *unused) {
  (void)unused;
  int error = c.stream ? hyperdht_stream_close_error(c.stream) : 0;
  if (error && !c.destroying) push("error", NULL, 0, error);
  c.stream = NULL; /* backend frees the handle after this callback */
  c.opened = c.connecting = c.writing = c.closing = c.resume = 0;
  push("close", NULL, 0, 0);
}
static void connected(int error, hyperdht_stream_t *stream, void *unused) {
  (void)unused;
  if (error || !stream) {
    c.connecting = 0;
    if (!c.destroying) {
      push("error", NULL, 0, error ? error : -102);
      push("close", NULL, 0, 0);
    }
    return;
  }
  c.stream = stream;
}
static void drained(hyperdht_stream_t *stream, void *unused) {
  (void)stream; (void)unused;
  c.writing = 0;
  push("drain", NULL, 0, 0);
}
int hdht_start(const char *bootstrap, const uint8_t *seed) {
  AUDIT_SCOPE;
  if (c.initialized) return -103;
  clear_events();
  memset(&c, 0, sizeof(c));
  int rc = uv_loop_init(&c.loop);
  if (rc) return rc;
  c.initialized = 1;
  rc = wifi_awake();
  if (rc) { hdht_shutdown(); return rc; }
  hyperdht_opts_t opts;
  hyperdht_opts_default(&opts);
  opts.ephemeral = 1;
  opts.use_public_bootstrap = !bootstrap || !bootstrap[0];
  if (bootstrap && bootstrap[0]) { opts.nodes = &bootstrap; opts.nodes_len = 1; }
  if (seed) { memcpy(opts.seed, seed, 32); opts.seed_is_set = 1; }
  c.dht = hyperdht_create(&c.loop, &opts);
  if (!c.dht) { hdht_shutdown(); return -104; }
  hyperdht_on_bootstrapped(c.dht, bootstrapped, NULL);
  rc = hyperdht_bind(c.dht, 0);
  if (rc) { hdht_shutdown(); return rc; }
  return 0;
}
int hdht_connect(const uint8_t key[32]) {
  AUDIT_SCOPE;
  if (!c.ready || c.destroying || c.server || c.stream || c.connecting || c.count) return -105;
  c.connecting = 1;
  int rc = hyperdht_connect_and_open_stream(c.dht, key, connected, opened,
                                            received, closed, NULL);
  if (rc) c.connecting = 0;
  return rc;
}
static int firewall(const uint8_t key[32], const char *host, uint16_t port, void *unused) {
  (void)host; (void)port; (void)unused;
  return c.destroying || c.stream || c.connecting || c.count ||
         memcmp(key, c.allowed_key, 32) != 0;
}
static void listening(void *unused) {
  (void)unused;
  push("listening", NULL, 0, 0);
}
static void incoming(const hyperdht_connection_t *conn, void *unused) {
  (void)unused;
  if (c.destroying || c.stream || c.connecting || c.count) {
    hyperdht_stream_t *rejected = hyperdht_stream_open(c.dht, conn, NULL, NULL, NULL, NULL);
    if (rejected) hyperdht_stream_destroy(rejected);
    return;
  }
  const char *hex = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    c.remote_hex[2*i] = hex[conn->remote_public_key[i] >> 4];
    c.remote_hex[2*i+1] = hex[conn->remote_public_key[i] & 15];
  }
  c.connecting = 1;
  push("accepting", NULL, 0, 0);
  c.stream = hyperdht_stream_open(c.dht, conn, opened, received, closed, NULL);
  if (!c.stream) { c.connecting = 0; push("error", NULL, 0, -108); push("close", NULL, 0, 0); }
}
int hdht_listen(const uint8_t allowed_key[32]) {
  AUDIT_SCOPE;
  if (!c.ready || c.destroying || c.server || c.stream || c.connecting || c.count) return -105;
  memcpy(c.allowed_key, allowed_key, 32);
  c.server = hyperdht_server_create(c.dht);
  if (!c.server) return -104;
  hyperdht_server_set_firewall(c.server, firewall, NULL);
  hyperdht_server_on_listening(c.server, listening, NULL);
  hyperdht_keypair_t kp;
  hyperdht_default_keypair(c.dht, &kp);
  int rc = hyperdht_server_listen(c.server, &kp, incoming, NULL);
  volatile uint8_t *wipe = (volatile uint8_t *)&kp;
  for (size_t i = 0; i < sizeof(kp); i++) wipe[i] = 0;
  if (rc) { hyperdht_server_close_force(c.server, NULL, NULL); c.server = NULL; }
  return rc;
}
int hdht_write(const uint8_t *data, size_t len) {
  AUDIT_SCOPE;
  if (!c.opened || c.destroying || c.closing || !c.stream) return -106;
  if (!len || len > HDHT_WRITE_MAX) return -107;
  if (c.writing) return 1; /* not accepted; caller must retry after drain */
  c.writing = 1;
  int rc = hyperdht_stream_write_with_drain(c.stream, data, len, drained, NULL);
  if (rc < 0) { c.writing = 0; return rc; }
  return 0; /* accepted, regardless of backend's positive success value */
}
void hdht_close(void) {
  AUDIT_SCOPE;
  if (c.connecting) { hdht_destroy(); return; }
  if (c.stream && !c.closing) {
    c.closing = 1;
    hyperdht_stream_close(c.stream);
  }
}
void hdht_destroy(void) {
  AUDIT_SCOPE;
  if (!c.initialized || c.destroying) return;
  c.destroying = 1;
  c.ready = c.opened = c.connecting = c.resume = 0;
  clear_events();
  if (c.stream) hyperdht_stream_destroy(c.stream);
  if (c.server) { hyperdht_server_close_force(c.server, NULL, NULL); c.server = NULL; }
  if (c.dht) hyperdht_destroy(c.dht, NULL, NULL);
  c.stream = NULL;
}
void hdht_tick(void) {
  AUDIT_SCOPE;
  if (!c.initialized) return;
  if (c.resume && c.stream && !c.destroying) {
    c.resume = 0;
    hyperdht_stream_resume(c.stream);
  }
  uv_run(&c.loop, UV_RUN_NOWAIT);
  if (c.fatal && !c.destroying) {
    int error = c.fatal;
    hdht_destroy();
    /* Keep error for delivery after teardown. */
    c.fatal = error;
  }
  if (c.destroying && !uv_loop_alive(&c.loop)) {
    /* Closing handles must be drained before the C++ instance is freed. */
    if (uv_loop_close(&c.loop) != 0) return;
    if (c.dht) hyperdht_free(c.dht);
    c.dht = NULL;
    c.initialized = c.destroying = 0;
    wifi_restore();
    if (c.fatal) push("error", NULL, 0, c.fatal);
    push("destroyed", NULL, 0, 0);
    AUDIT_SNAPSHOT("destroyed");
  }
}
void hdht_shutdown(void) {
  AUDIT_SCOPE;
  /* Espruino reset/kill: drain before the interpreter can be reset. */
  hdht_destroy();
  if (c.initialized) {
    uv_run(&c.loop, UV_RUN_DEFAULT);
    if (c.dht) hyperdht_free(c.dht);
    c.dht = NULL;
    uv_loop_close(&c.loop);
  }
  clear_events();
  wifi_restore();
  memset(&c, 0, sizeof(c));
}
int hdht_active(void) { return c.initialized; }
int hdht_public_key(uint8_t key[32]) {
  if (!c.dht || c.destroying) return -1;
  hyperdht_keypair_t kp;
  hyperdht_default_keypair(c.dht, &kp);
  memcpy(key, kp.public_key, 32);
  /* Do not keep the temporary secret key on the stack. */
  volatile uint8_t *p = (volatile uint8_t *)&kp;
  for (size_t i = 0; i < sizeof(kp); i++) p[i] = 0;
  return 0;
}
const char *hdht_event(const uint8_t **data, size_t *len, int *code) {
  if (!c.count) return NULL;
  struct event *e = &c.events[c.head];
  *len = e->len - e->offset;
  if (*len > HDHT_READ_CHUNK) *len = HDHT_READ_CHUNK;
  *data = e->data ? e->data + e->offset : NULL;
  *code = e->code;
  return e->type;
}
void hdht_consume(size_t len) {
  if (!c.count) return;
  struct event *e = &c.events[c.head];
  e->offset += len;
  if (e->offset < e->len) return;
  if (strcmp(e->type, "data") == 0) c.resume = 1;
  c.rx_bytes -= e->len;
  free(e->data);
  memset(e, 0, sizeof(*e));
  c.head = (c.head + 1) % EVENTS;
  c.count--;
}
