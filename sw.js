'use strict';

const CACHE_NAME = 'uex-golf-club-v30';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=30',
  './app.js?v=24',
  './manifest.webmanifest?v=23',
  './icons/favicon-32.png?v=24',
  './icons/apple-touch-icon-180.png?v=23',
  './icons/icon-192.png?v=23',
  './icons/icon-512.png?v=23',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match('./index.html'))));
});