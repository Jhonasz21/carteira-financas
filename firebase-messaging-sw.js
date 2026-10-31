importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js",
  "/api-config.js",
);

const config = self.MEU_PLUXEE_FIREBASE_CONFIG;
const requiredFields = ["apiKey", "authDomain", "projectId", "messagingSenderId", "appId"];

if (config && requiredFields.every((field) => typeof config[field] === "string" && config[field])) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage(() => {
    self.registration.showNotification("Meu Pluxee", {
      body: "Um novo lançamento foi sincronizado.",
      data: { url: "/" },
    });
  });
}

// Cache do app shell (PWA). Mesmo service worker do FCM, pois só há um por escopo.
const CACHE_NAME = "meu-pluxee-v1";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/api-config.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || (request.mode === "navigate" ? caches.match("/index.html") : Response.error()))),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
