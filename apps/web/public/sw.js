"use strict";

const VERSION = "1.0.0";
const CACHE = "tetrizz-" + VERSION;

const APP_SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

const NEVER_CACHE = [];

const sameOrigin = (u) => u.origin === self.location.origin;
const neverCache = (u) =>
  NEVER_CACHE.some((h) => u.hostname === h || u.hostname.endsWith("." + h)) ||
  (sameOrigin(u) && u.pathname.endsWith("/config.json"));
const cacheFirst = (u) =>
  u.hostname === "fonts.gstatic.com" ||
  u.hostname === "cdn.jsdelivr.net" ||
  (sameOrigin(u) && u.pathname !== "/" && u.pathname !== "/index.html");
const swr = (u) => u.hostname === "fonts.googleapis.com";

const storable = (r) => !!r && (r.ok || r.status === 0 || r.type === "opaque");

const put = (req, res) => {
  const copy = res.clone();
  caches
    .open(CACHE)
    .then((c) => c.put(req, copy))
    .catch(() => {});
};

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(APP_SHELL.map((u) => c.add(u).catch(() => {})))),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE && k.indexOf("tetrizz-") === 0)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (neverCache(url)) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          put("./index.html", res);
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then(
              (hit) => hit || caches.match("./index.html").then((h2) => h2 || caches.match("./")),
            ),
        ),
    );
    return;
  }

  if (cacheFirst(url)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (storable(res)) put(req, res);
            return res;
          }),
      ),
    );
    return;
  }

  if (swr(url) || sameOrigin(url)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const refresh = fetch(req)
          .then((res) => {
            if (storable(res)) put(req, res);
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      }),
    );
    return;
  }
});
