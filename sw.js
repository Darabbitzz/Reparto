'use strict';
// El nombre lleva el hash de index.html y lo reescribe ensamblar/publicar.js en cada
// publicación. El navegador solo reinstala el worker si ESTE archivo cambia: si la app
// cambia y el nombre no, se sirve la vieja para siempre. Pasó el 06/08/2026.
const CACHE = 'reparto-85e783ad65';
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

  // La app: RED PRIMERO, caché como respaldo. Antes era al revés, y por eso una
  // versión nueva podía no verse nunca. Sigue abriendo sin red; solo que ahora
  // prefiere la de verdad cuando la hay.
  ev.respondWith(
    fetch(ev.request)
      .then(r => {
        if (r && r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(ev.request, copia)); }
        return r;
      })
      .catch(() => caches.match(ev.request).then(r => r || caches.match('./index.html')))
  );
});
