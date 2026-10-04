#ifndef ESPR_HYPERDHT_CLIENT_H
#define ESPR_HYPERDHT_CLIENT_H
#include <stddef.h>
#include <stdint.h>
#define HDHT_WRITE_MAX 1024
#define HDHT_READ_CHUNK 256
/* All calls run on the interpreter thread. No worker touches Espruino. */
int hdht_start(const char *bootstrap, const uint8_t *seed);
int hdht_listen(const uint8_t allowed_key[32]);
int hdht_connect(const uint8_t key[32]);
int hdht_write(const uint8_t *data, size_t len);
void hdht_close(void);
void hdht_destroy(void);
void hdht_shutdown(void);
void hdht_tick(void);
int hdht_active(void);
int hdht_public_key(uint8_t key[32]);
/* Borrowed event bytes are valid until hdht_consume() / hdht_shutdown(). */
const char *hdht_event(const uint8_t **data, size_t *len, int *code);
void hdht_consume(size_t len);
#endif
