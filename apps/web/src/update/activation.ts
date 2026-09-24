export interface UpdateClient {
  id: string;
  url: string;
}
export function activationRejection(
  target: unknown,
  current: string,
  scope: string,
  source: UpdateClient | null,
  clients: readonly UpdateClient[],
): string | null {
  if (target !== current || !source || !source.url.startsWith(scope)) return 'invalid-request';
  const windows = clients.filter((client) => client.url.startsWith(scope));
  if (windows.length !== 1 || windows[0]?.id !== source.id) return 'other-clients';
  return null;
}
