import type { BackupData, BackupEnvelope } from './index';

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''));
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptBackup(data: BackupData, password: string): Promise<BackupEnvelope> {
  if (password.length < 12) throw new Error('备份密码至少 12 个字符');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 600000;
  const key = await derive(password, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('simcare:1') },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return {
    format: 'simcare-encrypted',
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    cipher: 'AES-256-GCM',
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}
export async function decryptBackup(
  envelope: BackupEnvelope,
  password: string,
): Promise<BackupData> {
  if (
    envelope.format !== 'simcare-encrypted' ||
    envelope.version !== 1 ||
    envelope.kdf !== 'PBKDF2-SHA256' ||
    envelope.cipher !== 'AES-256-GCM' ||
    envelope.iterations !== 600000
  )
    throw new Error('不支持的备份格式');
  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('备份损坏');
  const key = await derive(password, salt, envelope.iterations);
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('simcare:1') },
    key,
    fromBase64(envelope.ciphertext),
  );
  const data: BackupData = JSON.parse(new TextDecoder().decode(bytes));
  if (data.format !== 'simcare' || data.version !== 2 || !data.tables)
    throw new Error('不兼容的备份：仅支持手机号版本，旧 Passkey 备份不能直接恢复');
  return data;
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
