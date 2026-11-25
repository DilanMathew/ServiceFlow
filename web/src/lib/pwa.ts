/** Service worker registration and web push subscription for staff devices. */
import { api, post } from './api';
import { getClientConfig } from './monitoring';

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return Promise.resolve(null);
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((reg) => {
      // New deploy: refresh cached assets in the background.
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', () => undefined));
      return reg;
    })
    .catch(() => null);
  return registration;
}

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Must be called from a user gesture (button click): browsers require it for the permission prompt. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Notifications need the installed app (service worker unavailable).');
  const cfg = await getClientConfig();
  const key = cfg?.vapidPublicKey ?? (await api<{ data: { publicKey: string } }>('/app/notifications/push')).data.publicKey;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  const j = sub.toJSON();
  await post('/app/notifications/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    try { await post('/app/notifications/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* still unsubscribe locally */ }
    await sub.unsubscribe();
  }
  return 'off';
}

export const sendTestPush = () => post('/app/notifications/push/test');
