import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';

const NOTIFICATION_BODY = 'you win an iphone';
let firebaseApp = null;
let messaging = null;
let foregroundUnsubscribe = null;

export async function registerPushNotifications({ apiUrl, authToken, roomId }) {
  if (!authToken || !(await browserCanUseFirebaseMessaging())) {
    return null;
  }

  const config = firebaseConfigFromEnv();
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!config || !vapidKey) {
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return null;
  }

  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  const messagingInstance = getFirebaseMessaging(config);
  const pushToken = await getToken(messagingInstance, {
    vapidKey,
    serviceWorkerRegistration: registration
  });

  if (!pushToken) {
    return null;
  }

  await savePushToken({ apiUrl, authToken, roomId, pushToken });
  attachForegroundNotificationHandler(messagingInstance, registration);

  return pushToken;
}

export async function unregisterPushNotifications({ apiUrl, authToken, roomId, pushToken }) {
  if (!authToken || !pushToken) {
    return;
  }

  await fetch(`${apiUrl}/api/rooms/${encodeURIComponent(roomId)}/push-token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pushToken })
  }).catch(() => {});
}

export async function showLocalNotification(senderName) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const title = senderName ? `${senderName} sent a message` : 'New message';
  const options = {
    body: NOTIFICATION_BODY,
    tag: 'secure-chat-message',
    renotify: true
  };

  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return;
    }

    new Notification(title, options);
  } catch {
    // Notifications are best-effort because mobile browser support varies.
  }
}

export async function requestNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    return;
  }

  try {
    await Notification.requestPermission();
  } catch {
    // Some mobile browsers expose Notification but reject permission prompts.
  }
}

async function browserCanUseFirebaseMessaging() {
  return 'Notification' in window && 'serviceWorker' in navigator && (await isSupported());
}

function firebaseConfigFromEnv() {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
  };

  if (!config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId) {
    return null;
  }

  return Object.fromEntries(Object.entries(config).filter(([, value]) => Boolean(value)));
}

function getFirebaseMessaging(config) {
  if (!firebaseApp) {
    firebaseApp = initializeApp(config);
  }

  if (!messaging) {
    messaging = getMessaging(firebaseApp);
  }

  return messaging;
}

async function savePushToken({ apiUrl, authToken, roomId, pushToken }) {
  const response = await fetch(`${apiUrl}/api/rooms/${encodeURIComponent(roomId)}/push-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pushToken })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Unable to register push notifications.');
  }
}

function attachForegroundNotificationHandler(messagingInstance, registration) {
  foregroundUnsubscribe?.();
  foregroundUnsubscribe = onMessage(messagingInstance, async (payload) => {
    const title = payload.notification?.title || payload.data?.title || 'New message';
    const body = payload.notification?.body || payload.data?.body || NOTIFICATION_BODY;

    await registration.showNotification(title, {
      body,
      tag: 'secure-chat-message',
      renotify: true,
      data: payload.data || {}
    });
  });
}
