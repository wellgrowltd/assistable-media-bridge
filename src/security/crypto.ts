import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptionKey {
  version: string;
  key: Buffer;
}

export interface KeyRing {
  active: EncryptionKey;
  previous: EncryptionKey[];
}

const VERSION_PREFIX = "v";

export function createKeyRing(active: Buffer, version = "1", previous: EncryptionKey[] = []): KeyRing {
  if (active.length !== 32) throw new Error("active encryption key must be 32 bytes");
  if (!/^\d+$/.test(version)) throw new Error("encryption key version must be numeric");
  return { active: { version, key: Buffer.from(active) }, previous };
}

export function encryptVersioned(plain: string, ring: KeyRing): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.active.key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION_PREFIX + ring.active.version, iv, cipher.getAuthTag(), data]
    .map((part) => Buffer.isBuffer(part) ? part.toString("base64") : part)
    .join(":");
}

export function decryptVersioned(encoded: string, ring: KeyRing): string {
  const [version, iv64, tag64, data64] = encoded.split(":");
  if (!version || !iv64 || !tag64 || !data64 || !version.startsWith(VERSION_PREFIX)) {
    throw new Error("invalid encrypted value");
  }
  const keyVersion = version.slice(VERSION_PREFIX.length);
  const key = [ring.active, ...ring.previous].find((candidate) => candidate.version === keyVersion);
  if (!key) throw new Error(`encryption key version ${keyVersion} is unavailable`);
  const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data64, "base64")), decipher.final()]).toString("utf8");
}
