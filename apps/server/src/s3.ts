import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type Clock, systemClock } from "./clock.ts";
import type { Env } from "./env.ts";

const GET_EXPIRY_SECONDS = 26 * 3600; // 24 hours plus a margin (05)
const PUT_EXPIRY_SECONDS = 15 * 60;

export class PreconditionFailed extends Error {
  override name = "PreconditionFailed";
}

export type ObjectInfo = { key: string; etag: string; size: number; updatedAt: Date };
export type ObjectHead = ObjectInfo & { contentType: string | undefined; cacheControl: string | undefined };

type PutOptions = {
  contentType?: string;
  cacheControl?: string;
  /** Replace only this version of the object. */
  ifMatch?: string;
  /** Create only; fails if the key exists. */
  ifNoneMatch?: "*";
};

const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

const cleanEtag = (etag: string | undefined) => (etag ?? "").replaceAll('"', "");

function client(config: Env["s3"], endpoint: string) {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The default puts a checksum of an empty body into presigned PUTs, which SeaweedFS rejects (spike S3).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** The one way into the bucket. Keys and prefixes are owned by 02. */
export class Bucket {
  private readonly s3: S3Client;
  private readonly signer: S3Client;
  private readonly name: string;

  constructor(
    config: Env["s3"],
    private readonly clock: Clock = systemClock,
  ) {
    this.s3 = client(config, config.endpoint);
    this.signer = client(config, config.publicEndpoint);
    this.name = config.bucket;
  }

  /** Creates the bucket if it's missing (Compose). Railway's already exists. */
  async ensure(): Promise<"exists" | "created"> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.name }));
      return "exists";
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    await this.s3.send(new CreateBucketCommand({ Bucket: this.name }));
    return "created";
  }

  async put(key: string, body: Uint8Array | string, options: PutOptions = {}): Promise<{ etag: string }> {
    return this.conditional(async () => {
      const result = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.name,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          IfMatch: options.ifMatch,
          IfNoneMatch: options.ifNoneMatch,
        }),
      );
      return { etag: cleanEtag(result.ETag) };
    }, options.ifMatch !== undefined);
  }

  async get(
    key: string,
  ): Promise<{ body: Uint8Array; etag: string; contentType: string | undefined } | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.name, Key: key }));
      const body = await result.Body?.transformToByteArray();
      return {
        body: body ?? new Uint8Array(),
        etag: cleanEtag(result.ETag),
        contentType: result.ContentType,
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.name, Key: key }));
      return {
        key,
        etag: cleanEtag(result.ETag),
        size: result.ContentLength ?? 0,
        updatedAt: result.LastModified ?? new Date(0),
        contentType: result.ContentType,
        cacheControl: result.CacheControl,
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async list(
    prefix: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ objects: ObjectInfo[]; nextCursor: string | null }> {
    const result = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.name,
        Prefix: prefix,
        ContinuationToken: options.cursor,
        MaxKeys: options.limit ?? 1000,
      }),
    );
    return {
      objects: (result.Contents ?? []).map((object) => ({
        key: object.Key ?? "",
        etag: cleanEtag(object.ETag),
        size: object.Size ?? 0,
        updatedAt: object.LastModified ?? new Date(0),
      })),
      nextCursor: result.NextContinuationToken ?? null,
    };
  }

  async delete(key: string, options: { ifMatch?: string } = {}): Promise<void> {
    await this.conditional(async () => {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.name, Key: key, IfMatch: options.ifMatch }));
    }, options.ifMatch !== undefined);
  }

  /**
   * Signed with the time rounded down to the UTC day, so one object has one URL all day and
   * phones keep their cached copy (03).
   */
  presignGet(
    key: string,
    options: { responseContentType?: string; responseContentDisposition?: string } = {},
  ): Promise<string> {
    const signingDate = new Date(this.clock.now());
    signingDate.setUTCHours(0, 0, 0, 0);
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.name,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: GET_EXPIRY_SECONDS, signingDate },
    );
  }

  /** The uploader must send `headers` exactly: they're part of the signature (05). */
  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; cacheControl: string },
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.name,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
        CacheControl: options.cacheControl,
      }),
      {
        expiresIn: PUT_EXPIRY_SECONDS,
        signingDate: this.clock.now(),
        signableHeaders: new Set(["content-type", "content-length", "cache-control"]),
      },
    );
    return { url, headers: { "Content-Type": options.contentType, "Cache-Control": options.cacheControl } };
  }

  private async conditional<T>(write: () => Promise<T>, ifMatch: boolean): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const status = statusOf(error);
      // A bucket may answer 404 for If-Match on a missing key; to the caller that's a failed condition (08).
      if (status === 412 || (ifMatch && status === 404)) throw new PreconditionFailed("The object changed.");
      throw error;
    }
  }
}

/** The origin presigned URLs point at, for the viewer's and the content host's CSP. */
export function bucketOrigin(config: Env["s3"]): string {
  const url = new URL(config.publicEndpoint);
  if (!config.forcePathStyle) url.hostname = `${config.bucket}.${url.hostname}`;
  return url.origin;
}
