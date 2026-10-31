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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
