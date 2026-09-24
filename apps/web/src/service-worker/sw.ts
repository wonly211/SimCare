/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { currentBuild } from '../update/build';
import { activationRejection } from '../update/activation';
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/version\.json$/],
  }),
);
self.addEventListener('message', (event) => {
  const reply = (value: unknown) => event.ports[0]?.postMessage(value);
  if (event.data?.type === 'SIMCARE_BUILD') {
    reply(currentBuild);
    return;
  }
  if (event.data?.type !== 'SIMCARE_ACTIVATE') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const source =
        event.source && 'id' in event.source && 'url' in event.source
          ? (event.source as Client)
          : null;
      const reason = activationRejection(
        event.data.buildId,
        currentBuild.buildId,
        self.registration.scope,
        source,
        clients,
      );
      if (typeof event.data.expiresAt !== 'number' || event.data.expiresAt <= Date.now()) {
        reply({ ok: false, reason: 'expired' });
        return;
      }
      if (reason) {
        reply({ ok: false, reason });
        return;
      }
      await self.skipWaiting();
      reply({ ok: true });
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
