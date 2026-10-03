/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage — the only place image BYTES live. Postgres holds metadata.
 *
 * S3-compatible (SeaweedFS locally, any S3 in production). Browsers never
 * send files through the API: they PUT straight to storage with a presigned
 * URL whose signature pins the content type AND the exact byte length, so a
 * client cannot swap in a bigger or different file after validation.
 *
 * Key layout inside the media bucket:
 *   incoming/<mediaId>          private, unvalidated, swept if never confirmed
 *   originals/<mediaId>         private, validated original (kept for re-processing)
 *   public/<mediaId>/<variant>  processed variants, the only publicly served prefix
 */

export interface StorageConfig {
  endpoint: string;
  publicEndpoint?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl: string;
  /** Connect and inactivity limits per attempt (defaults 3 s / 5 s; tests shorten them). */
  timeouts?: { connectMs: number; idleMs: number };
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

export interface StorageProvider {
  presignPut(bucket: string, key: string, opts: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  head(bucket: string, key: string): Promise<ObjectHead | null>;
  get(bucket: string, key: string, opts?: { maxBytes?: number }): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, opts: { contentType: string; cacheControl?: string }): Promise<void>;
  copy(bucket: string, fromKey: string, toKey: string): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
  ensureBucket(bucket: string): Promise<void>;
  /** Browser URL of an object under `public/`. */
  publicUrl(key: string): string;
}

export class ObjectTooLargeError extends Error {}

export function createStorage(cfg: StorageConfig): StorageProvider {
  const client = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Checksums on presigned PUTs would make browsers compute CRC32 headers they don't send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // The SDK's default is no timeout at all: a storage server that accepts
      // connections and never answers (measured, Phase 20: `docker pause`)
      // held upload confirmations and image workers forever. socketTimeout is
      // inactivity, so a slow but progressing transfer is not cut off. With
      // the default 3 attempts a hung call now fails in ≈15 s.
      requestHandler: { connectionTimeout: cfg.timeouts?.connectMs ?? 3_000, socketTimeout: cfg.timeouts?.idleMs ?? 5_000 },
    });
  const s3 = client(cfg.endpoint);
  const signer = cfg.publicEndpoint && cfg.publicEndpoint !== cfg.endpoint ? client(cfg.publicEndpoint) : s3;
  const notFound = (e: unknown) => {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
  };

  return {
    async presignPut(bucket, key, o) {
      const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: o.contentType, ContentLength: o.contentLength });
      // Both headers are SIGNED: storage rejects a PUT whose type or length differs.
      const url = await getSignedUrl(signer, cmd, { expiresIn: o.expiresInSeconds, signableHeaders: new Set(['content-type', 'content-length']) });
      return { url, headers: { 'content-type': o.contentType } };
    },
    async head(bucket, key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: r.ContentLength ?? 0, contentType: r.ContentType };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async get(bucket, key, opts = {}) {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (opts.maxBytes && (r.ContentLength ?? 0) > opts.maxBytes) throw new ObjectTooLargeError(key);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (opts.maxBytes && total > opts.maxBytes) throw new ObjectTooLargeError(key);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async put(bucket, key, body, o) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: o.contentType, ...(o.cacheControl ? { CacheControl: o.cacheControl } : {}) }));
    },
    async copy(bucket, fromKey, toKey) {
      await s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${fromKey}`, Key: toKey }));
    },
    async delete(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async ensureBucket(bucket) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (e) {
        if (!notFound(e)) throw e;
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    publicUrl: (key) => {
      if (!key.startsWith('public/')) throw new Error('only public/ keys have a public URL');
      return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    },
  };
}

export const storageConfigFromEnv = (env: {
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT?: string | undefined;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  MEDIA_PUBLIC_BASE_URL: string;
}): StorageConfig => ({
  endpoint: env.S3_ENDPOINT,
  publicEndpoint: env.S3_PUBLIC_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
});