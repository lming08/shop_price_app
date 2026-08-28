/* 包姐便利店 · 查价 —— Service Worker：预缓存全部文件，离线可用
 * 注意：更新前端文件后请把 CACHE 版本号 +1，老用户才能拿到新版本 */
'use strict';

const CACHE = 'baojie-price-v4';
const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/app.css',
  'js/db.js',
  'js/scanner.js',
  'js/excel.js',
  'js/backup.js',
  'js/app.js',
  'lib/vue.global.prod.js',
  'lib/html5-qrcode.min.js',
  'lib/xlsx.full.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match('index.html'));
    })
  );
});
