import { expect, it } from 'vitest';
import { decryptBackup, encryptBackup } from './backup';
import type { BackupData } from './index';

it('加密备份往返、错误密码和篡改拒绝', async () => {
  const data: BackupData = {
    format: 'simcare',
    version: 2,
    createdAt: '2026-09-22T08:00:00+08:00',
    sourceId: 'test-only',
    tables: {},
  };
  const encrypted = await encryptBackup(data, 'test-only-password');
  expect(encrypted.ciphertext).not.toContain('tables');
  expect(await decryptBackup(encrypted, 'test-only-password')).toEqual(data);
  await expect(decryptBackup(encrypted, 'wrong-password')).rejects.toThrow();
  await expect(
    decryptBackup({ ...encrypted, version: 2 } as never, 'test-only-password'),
  ).rejects.toThrow();
  await expect(encryptBackup(data, 'short')).rejects.toThrow();
});
