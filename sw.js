'use strict';
const CACHE = 'reparto-2026-08-04-e827d41f6f';
const ESTATICOS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(ESTATICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET') return;

  // precios.json: red primero, caché como red de seguridad. Nunca al revés.
  if (url.pathname.endsWith('precios.json')) {
    ev.respondWith(
      fetch(ev.request).then(r => {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(ev.request, copia));
        return r;
      }).catch(() => caches.match(ev.request))
    );
    return;
  }

  // Lo demás es la app: caché primero, que es lo que la hace abrir sin red.
  ev.respondWith(caches.match(ev.request).then(r => r || fetch(ev.request)));
});
