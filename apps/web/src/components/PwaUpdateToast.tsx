import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';
import { toast } from 'sonner';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers the service worker (production builds only) and shows a toast
 * with a "Reload" action when a new version has been downloaded.
 * Renders nothing itself.
 */
export function PwaUpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      // Browsers only look for a new sw.js on navigation. A tab that stays
      // open all day would never hear about updates, so also check hourly.
      if (registration) {
        setInterval(() => registration.update(), UPDATE_CHECK_INTERVAL_MS);
      }
    },
    onRegisterError(error) {
      console.error('Service worker registration failed', error);
    },
  });

  useEffect(() => {
    if (!needRefresh) return;
    toast('A new version is available', {
      id: 'pwa-update',
      description: 'Reload to get the latest version of the app.',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Reload', onClick: () => updateServiceWorker(true) },
      onDismiss: () => setNeedRefresh(false),
    });
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
