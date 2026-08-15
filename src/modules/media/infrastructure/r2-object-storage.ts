import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import type {
  BoundedObjectReadInput,
  BoundedObjectReadResult,
  ObjectHeadResult,
  ObjectStorage,
  ObjectStorageKey,
  PresignedGet,
  PresignedGetInput,
  PresignedPut,
  PresignedPutInput,
} from '../application/ports/object-storage';

const service = 's3';
const region = 'auto';
const algorithm = 'AWS4-HMAC-SHA256';
const unsignedPayload = 'UNSIGNED-PAYLOAD';
const requestTimeoutMs = 10_000;

interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(secret: string, date: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function amzDate(now: Date): {
  readonly date: string;
  readonly timestamp: string;
} {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return { date: timestamp.slice(0, 8), timestamp };
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}

function canonicalUri(key: ObjectStorageKey): string {
  return `/${key.split('/').map(encode).join('/')}`;
}

function canonicalQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join('&');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  readonly canonical: string;
  readonly signed: string;
} {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    canonical: `${entries.map(([key, value]) => `${key}:${value}`).join('\n')}\n`,
    signed: entries.map(([key]) => key).join(';'),
  };
}

function signature(input: {
  readonly method: string;
  readonly uri: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly timestamp: string;
  readonly date: string;
  readonly credentials: SigningCredentials;
}): string {
  const headers = canonicalHeaders(input.headers);
  const scope = `${input.date}/${region}/${service}/aws4_request`;
  const canonicalRequest = [
    input.method,
    input.uri,
    input.query,
    headers.canonical,
    headers.signed,
    input.payloadHash,
  ].join('\n');
  const stringToSign = [
    algorithm,
    input.timestamp,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  return createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, input.date),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');
}

@Injectable()
export class R2ObjectStorage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly credentials: SigningCredentials;

  constructor(@Inject(APP_CONFIG) configuration: AppConfig) {
    this.endpoint = new URL(
      `https://${configuration.r2.accountId}.r2.cloudflarestorage.com/${encode(
        configuration.r2.bucketName,
      )}`,
    );
    this.credentials = configuration.r2;
  }

  createPresignedPut(input: PresignedPutInput): Promise<PresignedPut> {
    const now = new Date();
    const { date, timestamp } = amzDate(now);
    const uri = `${this.endpoint.pathname}${canonicalUri(input.key)}`;
    const requestHeaders = {
      host: this.endpoint.host,
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
      'if-none-match': '*',
    };
    const headers = canonicalHeaders(requestHeaders);
    const scope = `${date}/${region}/${service}/aws4_request`;
    const parameters: Record<string, string> = {
      'X-Amz-Algorithm': algorithm,
      'X-Amz-Content-Sha256': unsignedPayload,
      'X-Amz-Credential': `${this.credentials.accessKeyId}/${scope}`,
      'X-Amz-Date': timestamp,
      'X-Amz-Expires': String(input.expiresInSeconds),
      'X-Amz-SignedHeaders': headers.signed,
    };
    const query = canonicalQuery(parameters);
    parameters['X-Amz-Signature'] = signature({
      method: 'PUT',
      uri,
      query,
      headers: requestHeaders,
      payloadHash: unsignedPayload,
      timestamp,
      date,
      credentials: this.credentials,
    });
    return Promise.resolve({
      url: `${this.endpoint.origin}${uri}?${canonicalQuery(parameters)}`,
      method: 'PUT',
      requiredHeaders: Object.freeze({
        'content-type': input.contentType,
        'content-length': String(input.contentLength),
        'if-none-match': '*' as const,
      }),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000),
    });
  }

  createPresignedGet(input: PresignedGetInput): Promise<PresignedGet> {
    const signingWindowMs = 5 * 60 * 1_000;
    const now = new Date(
      Math.floor(Date.now() / signingWindowMs) * signingWindowMs,
    );
    const { date, timestamp } = amzDate(now);
    const uri = `${this.endpoint.pathname}${canonicalUri(input.key)}`;
    const requestHeaders = { host: this.endpoint.host };
    const headers = canonicalHeaders(requestHeaders);
    const scope = `${date}/${region}/${service}/aws4_request`;
    const parameters: Record<string, string> = {
      'X-Amz-Algorithm': algorithm,
      'X-Amz-Content-Sha256': unsignedPayload,
      'X-Amz-Credential': `${this.credentials.accessKeyId}/${scope}`,
      'X-Amz-Date': timestamp,
      'X-Amz-Expires': String(input.expiresInSeconds),
      'X-Amz-SignedHeaders': headers.signed,
    };
    const query = canonicalQuery(parameters);
    parameters['X-Amz-Signature'] = signature({
      method: 'GET',
      uri,
      query,
      headers: requestHeaders,
      payloadHash: unsignedPayload,
      timestamp,
      date,
      credentials: this.credentials,
    });
    return Promise.resolve({
      url: `${this.endpoint.origin}${uri}?${canonicalQuery(parameters)}`,
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000),
    });
  }

  async head(key: ObjectStorageKey): Promise<ObjectHeadResult> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return { kind: 'not-found' };
    await requireSuccessful(response);
    const rawLength = response.headers.get('content-length');
    const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error('R2 object metadata has no valid content length');
    }
    return {
      kind: 'found',
      metadata: {
        contentLength,
        contentType: response.headers.get('content-type'),
      },
    };
  }

  async readBounded(
    input: BoundedObjectReadInput,
  ): Promise<BoundedObjectReadResult> {
    const metadata = await this.head(input.key);
    if (metadata.kind === 'not-found') return metadata;
    if (metadata.metadata.contentLength > input.maxBytes) {
      return {
        kind: 'too-large',
        contentLength: metadata.metadata.contentLength,
      };
    }
    const response = await this.request('GET', input.key, {
      range: `bytes=0-${input.maxBytes - 1}`,
    });
    if (response.status === 404) return { kind: 'not-found' };
    await requireSuccessful(response);
    if (response.body === null) throw new Error('R2 object body is missing');
    return {
      kind: 'found',
      metadata: metadata.metadata,
      body: response.body as unknown as AsyncIterable<Uint8Array>,
    };
  }

  async delete(key: ObjectStorageKey): Promise<void> {
    const response = await this.request('DELETE', key);
    await requireSuccessful(response);
  }

  private async request(
    method: 'DELETE' | 'GET' | 'HEAD',
    key: ObjectStorageKey,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const now = new Date();
    const { date, timestamp } = amzDate(now);
    const uri = `${this.endpoint.pathname}${canonicalUri(key)}`;
    const payloadHash = sha256('');
    const headers = {
      host: this.endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      ...additionalHeaders,
    };
    const canonical = canonicalHeaders(headers);
    const scope = `${date}/${region}/${service}/aws4_request`;
    const signed = signature({
      method,
      uri,
      query: '',
      headers,
      payloadHash,
      timestamp,
      date,
      credentials: this.credentials,
    });
    return fetch(`${this.endpoint.origin}${uri}`, {
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        ...headers,
        authorization: `${algorithm} Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${canonical.signed}, Signature=${signed}`,
      },
    });
  }
}

async function requireSuccessful(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`R2 request failed with status ${response.status}`);
}
