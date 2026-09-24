export interface SyncChannel {
  postMessage(message: unknown): void;
  listen(listener: (message: unknown) => Promise<void>): () => void;
  close(): void;
}

export function browserSyncChannel(name: string): SyncChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(name);
  return {
    postMessage: (message) => channel.postMessage(message),
    listen(listener) {
      const handler = (event: MessageEvent) => {
        void listener(event.data);
      };
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    close: () => channel.close(),
  };
}
