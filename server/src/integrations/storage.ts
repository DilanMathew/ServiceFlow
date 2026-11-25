import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import type { Readable } from 'node:stream';

/** Object storage abstraction. Keys are random and never derived from user input or exposed as public URLs. */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  health(): Promise<boolean>;
}

class LocalStorage implements Storage {
  root = path.resolve(config.STORAGE_LOCAL_DIR);
  private p(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, body: Buffer) { const f = this.p(key); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, body); }
  async get(key: string) { return fs.createReadStream(this.p(key)); }
  async delete(key: string) { await fsp.rm(this.p(key), { force: true }); }
  async health() { await fsp.mkdir(this.root, { recursive: true }); return true; }
}

class S3Storage implements Storage {
  client = new S3Client({
    region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE ?? !!config.S3_ENDPOINT,
    credentials: config.S3_ACCESS_KEY_ID ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY! } : undefined,
  });
  bucket = config.S3_BUCKET!;
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: config.S3_ENDPOINT ? undefined : 'AES256' }));
  }
  async get(key: string) { return (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))).Body as Readable; }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  /** Real round trip (write, read, delete a tiny probe object) so bad credentials or URL style fail loudly. */
  async health() {
    const key = `_health/${process.pid}-${Date.now()}.txt`;
    await this.put(key, Buffer.from('ok'), 'text/plain');
    const body = await this.get(key);
    for await (const _ of body) { /* drain */ }
    await this.delete(key);
    return true;
  }
}

export const storage: Storage = config.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
