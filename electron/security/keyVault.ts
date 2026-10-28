/**
 * Encrypts the persona's secrets at rest: the Ed25519 private key, and publishing credentials
 * (SFTP/FTP password, GitHub token). The database stores either a plaintext PEM
 * (legacy, or when no OS keychain is available) or `enc:v1:<base64>` sealed by the cipher.
 *
 * The cipher is OS-backed (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux), so it's only available inside the running Studio app. The stdio MCP CLI
 * runs under plain Node without it: it can still read everything, but anything that signs
 * (export/publish) fails with `KeyVaultUnavailableError`.
 */
export interface KeyCipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export const ENCRYPTED_KEY_PREFIX = 'enc:v1:';

export class KeyVaultUnavailableError extends Error {
  constructor() {
    super(
      'This persona’s signing key and publishing credentials are encrypted with the OS keychain, which is only available inside the Webring Studio app. Open Webring Studio to publish (or use its in-app HTTP MCP endpoint).'
    );
    this.name = 'KeyVaultUnavailableError';
  }
}

export function isEncryptedKey(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_KEY_PREFIX);
}

/**
 * Returns the value to store: sealed when a cipher is available, otherwise unchanged.
 */
export function sealPrivateKey(privateKeyPem: string, cipher?: KeyCipher): string {
  if (isEncryptedKey(privateKeyPem) || !cipher?.isAvailable()) {
    return privateKeyPem;
  }
  return `${ENCRYPTED_KEY_PREFIX}${cipher.encrypt(privateKeyPem).toString('base64')}`;
}

export function openPrivateKey(stored: string, cipher?: KeyCipher): string {
  if (!isEncryptedKey(stored)) {
    return stored;
  }
  if (!cipher?.isAvailable()) {
    throw new KeyVaultUnavailableError();
  }
  return cipher.decrypt(Buffer.from(stored.slice(ENCRYPTED_KEY_PREFIX.length), 'base64'));
}

/** Same sealing for any secret string (publishing passwords and tokens). */
export const sealSecret = sealPrivateKey;
export const openSecret = openPrivateKey;
