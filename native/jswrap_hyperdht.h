#ifndef JSWRAP_HYPERDHT_H
#define JSWRAP_HYPERDHT_H
#include "jsvar.h"
JsVar *jswrap_hyperdht_start(JsVar *bootstrap, JsVar *seed);
int jswrap_hyperdht_listen(JsVar *key);
int jswrap_hyperdht_connect(JsVar *key);
int jswrap_hyperdht_write(JsVar *data);
JsVar *jswrap_hyperdht_poll(void);
void jswrap_hyperdht_close(void);
void jswrap_hyperdht_destroy(void);
void jswrap_hyperdht_kill(void);
#endif
