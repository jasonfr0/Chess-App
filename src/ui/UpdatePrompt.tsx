import { useRegisterSW } from 'virtual:pwa-register/react';
import { UpdateBanner } from './UpdateBanner';

const CHECK_EVERY_MS = 30 * 60 * 1000;

/**
 * Registers the offline service worker and offers a reload when a new version is ready, instead of
 * swapping files under a running page. Checks for updates on open, every 30 minutes, and whenever the
 * app comes back to the foreground.
 */
export function UpdatePrompt() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { registration.update().catch(() => { /* offline: try again later */ }); };
      setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    },
  });
  return (
    <UpdateBanner
      needRefresh={needRefresh}
      onReload={() => { void updateServiceWorker(true); }}
      onDismiss={() => setNeedRefresh(false)}
    />
  );
}
