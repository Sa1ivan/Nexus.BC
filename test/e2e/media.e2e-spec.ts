import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import ts from 'typescript';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG } from '../../src/shared/config/app-config.schema';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { CompleteMediaUpload } from '../../src/modules/media/application/complete-media-upload';
import {
  buildImportMediaObjectKey,
  buildProjectMediaObjectKey,
  OBJECT_STORAGE,
  type BoundedObjectReadResult,
  type ObjectStorage,
  type ObjectStorageKey,
  type PresignedPutInput,
} from '../../src/modules/media/application/ports/object-storage';
import {
  MEDIA_INSPECTOR,
  type InspectedImage,
  type MediaInspector,
} from '../../src/modules/media/application/ports/media-inspector';
import { MEDIA_MAX_BYTES } from '../../src/modules/media/domain/media-asset';
import { PrismaMediaRepository } from '../../src/modules/media/infrastructure/prisma-media.repository';
import { SharpMediaInspector } from '../../src/modules/media/infrastructure/sharp-media-inspector';
import type { AuditWriter } from '../../src/shared/audit/audit-writer';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import { TransactionRunner } from '../../src/shared/database/transaction-runner';
import {
  createV5TestDatabase,
  type V5TestDatabase,
} from './support/v5-test-database';

const allowedOrigin = 'http://localhost:4200';
const accessTokenSecret = 'test-access-token-secret-32-bytes';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const pngChecksum = createHash('sha256').update(png).digest('hex');

interface TestIdentity {
  readonly accessToken: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface SeededAsset {
  readonly assetId: string;
  readonly key: ObjectStorageKey;
}

interface AssetEvidenceOverride {
  readonly declaredChecksumSha256?: string;
  readonly declaredSizeBytes?: number;
  readonly projectId?: string | null;
  readonly status?: 'PENDING' | 'READY' | 'DELETING';
  readonly workspaceId?: string;
}

interface DiscoveredCleanup {
  invoke(now: Date): Promise<unknown>;
}

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<ObjectStorageKey, Uint8Array>();
  readonly oversized = new Set<ObjectStorageKey>();
  readonly failedDeletes = new Set<ObjectStorageKey>();
  readonly deletes: ObjectStorageKey[] = [];
  reads = 0;

  createPresignedPut(input: PresignedPutInput) {
    return Promise.resolve({
      url: `https://storage.example.test/${input.key}`,
      method: 'PUT' as const,
      requiredHeaders: Object.freeze({
        'content-type': input.contentType,
        'if-none-match': '*' as const,
      }),
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
    });
  }

  createPresignedGet(input: { readonly key: ObjectStorageKey }) {
    return Promise.resolve({
      url: `https://storage.example.test/${input.key}?signature=test`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    });
  }

  head(key: ObjectStorageKey) {
    const bytes = this.objects.get(key);
    return Promise.resolve(
      bytes === undefined
        ? ({ kind: 'not-found' } as const)
        : ({
            kind: 'found',
            metadata: {
              contentLength: bytes.byteLength,
              contentType: 'image/png',
            },
          } as const),
    );
  }

  readBounded(input: {
    readonly key: ObjectStorageKey;
    readonly maxBytes: number;
  }): Promise<BoundedObjectReadResult> {
    this.reads += 1;
    if (this.oversized.has(input.key)) {
      return Promise.resolve({
        kind: 'too-large',
        contentLength: MEDIA_MAX_BYTES + 1,
      });
    }
    const bytes = this.objects.get(input.key);
    return Promise.resolve(
      bytes === undefined
        ? ({ kind: 'not-found' } as const)
        : ({
            kind: 'found',
            metadata: {
              contentLength: bytes.byteLength,
              contentType: 'image/png',
            },
            body: Readable.from([bytes]),
          } as const),
    );
  }

  delete(key: ObjectStorageKey): Promise<void> {
    this.deletes.push(key);
    if (this.failedDeletes.has(key)) {
      return Promise.reject(new Error('Controlled object deletion failure'));
    }
    this.objects.delete(key);
    return Promise.resolve();
  }
}

class MutableMediaInspector implements MediaInspector {
  private controlled:
    | {
        readonly bytes: Uint8Array;
        readonly result: InspectedImage | null;
      }
    | undefined;

  constructor(private readonly delegate: MediaInspector) {}

  inspect(bytes: Uint8Array): Promise<InspectedImage | null> {
    if (
      this.controlled !== undefined &&
      Buffer.from(bytes).equals(Buffer.from(this.controlled.bytes))
    ) {
      return Promise.resolve(this.controlled.result);
    }
    return this.delegate.inspect(bytes);
  }

  control(bytes: Uint8Array, result: InspectedImage | null): void {
    this.controlled = { bytes, result };
  }

  clear(): void {
    this.controlled = undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function sourceProgram(): ts.Program {
  const configPath = resolve('tsconfig.json');
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    process.cwd(),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function errorCode(response: request.Response): unknown {
  const body: unknown = response.body;
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  return body['error']['code'];
}

function fixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve('contracts/site-config/fixtures', name), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error(`Fixture ${name} is not an object`);
  return parsed;
}

function managedMedia(assetId: string, alt: string): Record<string, unknown> {
  return { kind: 'managed', assetId, alt };
}

function managedConfig(
  firstAssetId: string,
  nonFirstAssetId = firstAssetId,
): Record<string, unknown> {
  const config = structuredClone(fixture('v5-managed-valid.json'));
  const business = config['business'];
  if (!isRecord(business)) throw new Error('Managed fixture has no business');
  business['logo'] = managedMedia(firstAssetId, 'Managed logo');
  const pages = config['pages'];
  if (!Array.isArray(pages) || !isRecord(pages[0])) {
    throw new Error('Managed fixture has no first page');
  }
  const blocks = pages[0]['blocks'];
  if (!Array.isArray(blocks) || !isRecord(blocks[0])) {
    throw new Error('Managed fixture has no first block');
  }
  blocks[0]['media'] = managedMedia(firstAssetId, 'Managed hero');

  const secondPage = structuredClone(pages[0]);
  secondPage['id'] = 'page-secondary';
  secondPage['slug'] = 'secondary';
  secondPage['title'] = 'Secondary';
  const secondBlocks = secondPage['blocks'];
  if (!Array.isArray(secondBlocks) || !isRecord(secondBlocks[0])) {
    throw new Error('Managed fixture has no secondary hero');
  }
  const secondHero = structuredClone(secondBlocks[0]);
  secondHero['id'] = 'hero-secondary';
  secondHero['anchor'] = 'secondary-hero';
  secondHero['media'] = managedMedia(nonFirstAssetId, 'Managed secondary hero');
  secondPage['blocks'] = [secondHero];
  pages.push(secondPage);
  return config;
}

function signAccessToken(userId: string, email: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email,
      iat: issuedAt,
      exp: issuedAt + 600,
    }),
    'utf8',
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', accessTokenSecret)
    .update(unsigned, 'utf8')
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

describe('managed media readiness and publish', () => {
  let app: INestApplication<App>;
  let audit: AuditWriter;
  let inspector: SharpMediaInspector;
  let publishInspector: MutableMediaInspector;
  let prisma: PrismaClient;
  let repository: PrismaMediaRepository;
  let storage: MemoryObjectStorage;
  let transactions: TransactionRunner;
  let testDatabase: V5TestDatabase;
  let alternatePng: Buffer;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    testDatabase = await createV5TestDatabase('nexus_media');
    storage = new MemoryObjectStorage();
    publishInspector = new MutableMediaInspector(new SharpMediaInspector());
    const builder = Test.createTestingModule({
      imports: [AppModule],
    });
    builder.overrideProvider(APP_CONFIG).useValue(testDatabase.configuration);
    builder.overrideProvider(OBJECT_STORAGE).useValue(storage);
    builder.overrideProvider(MEDIA_INSPECTOR).useValue(publishInspector);
    const moduleFixture = await builder.compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    await app.init();
    prisma = app.get<PrismaClient>(PrismaClientService);
    repository = app.get(PrismaMediaRepository);
    inspector = app.get(SharpMediaInspector);
    transactions = app.get(TransactionRunner);
    audit = { append: () => Promise.resolve() };
    alternatePng = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 220, g: 10, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  });

  afterEach(async () => {
    publishInspector.clear();
    if (workspaceIds.length === 0) return;
    await prisma.idempotencyRecord.deleteMany({
      where: {
        OR: workspaceIds.map((workspaceId) => ({
          scope: { startsWith: `workspace:${workspaceId}` },
        })),
      },
    });
    await prisma.activeRelease.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.release.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.projectRevision.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.mediaImportBatch.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.project.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.membership.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds.length = 0;
    workspaceIds.length = 0;
    storage.objects.clear();
    storage.oversized.clear();
    storage.failedDeletes.clear();
    storage.deletes.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await testDatabase.dispose();
  });

  async function seedIdentity(label: string): Promise<TestIdentity> {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const email = `${label}-${userId}@example.test`;
    userIds.push(userId);
    workspaceIds.push(workspaceId);
    await prisma.user.create({
      data: {
        id: userId,
        email,
        passwordHash: 'not-used-by-media-contract',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, name: `${label} workspace` },
    });
    await prisma.membership.create({
      data: { userId, workspaceId, role: 'OWNER' },
    });
    const initial = fixture('v4-minimal-valid.json');
    const operationId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        createOperationId: operationId,
        name: `${label} project`,
        publicSlug: `media-${randomUUID()}`,
        draft: initial,
        draftSchemaVersion: 4,
        revisions: {
          create: {
            operationId,
            version: 1,
            siteConfig: initial,
            schemaVersion: 4,
          },
        },
      },
    });
    return {
      userId,
      workspaceId,
      projectId,
      accessToken: signAccessToken(userId, email),
    };
  }

  async function seedProjectAsset(
    identity: TestIdentity,
    override: AssetEvidenceOverride = {},
  ): Promise<SeededAsset> {
    const assetId = randomUUID();
    const projectId = override.projectId ?? identity.projectId;
    const workspaceId = override.workspaceId ?? identity.workspaceId;
    if (projectId === null) throw new Error('Project asset requires a project');
    const key = buildProjectMediaObjectKey({
      workspaceId,
      projectId,
      assetId,
      safeName: 'hero.png',
    });
    const status = override.status ?? 'READY';
    const hasVerification = status !== 'PENDING';
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId,
        projectId,
        objectKey: key,
        status,
        declaredFileName: 'hero.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: override.declaredSizeBytes ?? png.byteLength,
        declaredChecksumSha256: override.declaredChecksumSha256 ?? pngChecksum,
        verifiedMimeType: hasVerification ? 'image/png' : null,
        verifiedSizeBytes: hasVerification ? png.byteLength : null,
        verifiedWidth: hasVerification ? 1 : null,
        verifiedHeight: hasVerification ? 1 : null,
        verifiedChecksumSha256: hasVerification ? pngChecksum : null,
        verifiedAt: hasVerification ? new Date() : null,
        deletionMarkedAt: status === 'DELETING' ? new Date() : null,
      },
    });
    return { assetId, key };
  }

  function completion(storage: ObjectStorage): CompleteMediaUpload {
    return new CompleteMediaUpload(
      repository,
      storage,
      inspector,
      transactions,
      audit,
    );
  }

  async function publish(
    identity: TestIdentity,
    firstAssetId: string,
    nonFirstAssetId = firstAssetId,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/publish`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 1,
        siteConfig: managedConfig(firstAssetId, nonFirstAssetId),
      });
  }

  async function publishWithoutProjectMutation(
    identity: TestIdentity,
    firstAssetId: string,
    nonFirstAssetId = firstAssetId,
  ): Promise<request.Response> {
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: identity.projectId },
    });
    const response = await publish(identity, firstAssetId, nonFirstAssetId);
    await expect(
      prisma.project.findUniqueOrThrow({
        where: { id: identity.projectId },
      }),
    ).resolves.toEqual(before);
    return response;
  }

  async function activate(
    identity: TestIdentity,
    releaseId: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/releases/${releaseId}/activate`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID());
  }

  async function releaseState(identity: TestIdentity): Promise<{
    readonly active: number;
    readonly releases: number;
    readonly revisions: number;
  }> {
    const [active, releases, revisions] = await Promise.all([
      prisma.activeRelease.count({
        where: { projectId: identity.projectId },
      }),
      prisma.release.count({ where: { projectId: identity.projectId } }),
      prisma.projectRevision.count({
        where: { projectId: identity.projectId },
      }),
    ]);
    return { active, releases, revisions };
  }

  function discoverCleanupUseCase(): DiscoveredCleanup {
    const program = sourceProgram();
    const checker = program.getTypeChecker();
    const mediaRoot = resolve('src/modules/media');
    const storagePortFile = resolve(
      'src/modules/media/application/ports/object-storage.ts',
    );
    const storageSource = program.getSourceFile(storagePortFile);
    if (storageSource === undefined)
      throw new Error('ObjectStorage port missing');
    let deleteSymbol: ts.Symbol | undefined;
    let storageToken: ts.Symbol | undefined;
    for (const statement of storageSource.statements) {
      if (
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text === 'ObjectStorage'
      ) {
        const member = statement.members.find(
          (candidate) =>
            ts.isMethodSignature(candidate) &&
            candidate.name.getText(storageSource) === 'delete',
        );
        if (member !== undefined) {
          deleteSymbol = resolvedSymbol(checker, member.name);
        }
      }
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(
          (candidate) =>
            ts.isIdentifier(candidate.name) &&
            candidate.name.text === 'OBJECT_STORAGE',
        );
        if (declaration !== undefined) {
          storageToken = resolvedSymbol(checker, declaration.name);
        }
      }
    }
    if (deleteSymbol === undefined || storageToken === undefined) {
      throw new Error('ObjectStorage cleanup contract is incomplete');
    }

    const hasStorageDependency = (declaration: ts.ClassDeclaration): boolean =>
      declaration.members.some(
        (member) =>
          ts.isConstructorDeclaration(member) &&
          member.parameters.some((parameter) =>
            (ts.canHaveDecorators(parameter)
              ? (ts.getDecorators(parameter) ?? [])
              : []
            ).some((decorator) => {
              if (!ts.isCallExpression(decorator.expression)) return false;
              const token = decorator.expression.arguments[0];
              return (
                token !== undefined &&
                resolvedSymbol(checker, token) === storageToken
              );
            }),
          ),
      );

    const bodyOf = (
      declaration: ts.SignatureDeclaration,
    ): ts.Node | undefined => {
      if (
        ts.isMethodDeclaration(declaration) ||
        ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration)
      ) {
        return declaration.body;
      }
      return undefined;
    };
    const tracesCleanup = (entry: ts.SignatureDeclaration): boolean => {
      const queue: ts.Node[] = [entry];
      const visited = new Set<ts.Node>();
      let deletesObject = false;
      let checksExpiry = false;
      let checksAttachment = false;
      while (queue.length > 0 && visited.size < 80) {
        const current = queue.shift();
        if (current === undefined || visited.has(current)) continue;
        visited.add(current);
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) {
            if (node.text === 'expiresAt') checksExpiry = true;
            if (node.text === 'attachedAt') checksAttachment = true;
          }
          if (ts.isCallExpression(node)) {
            const signature = checker.getResolvedSignature(node);
            const declaration = signature?.declaration;
            if (declaration !== undefined) {
              const name = 'name' in declaration ? declaration.name : undefined;
              if (
                name !== undefined &&
                resolvedSymbol(checker, name) === deleteSymbol
              ) {
                deletesObject = true;
              }
              const body = bodyOf(declaration);
              if (
                body !== undefined &&
                declaration.getSourceFile().fileName.startsWith(mediaRoot)
              ) {
                queue.push(body);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(current);
      }
      return deletesObject && checksExpiry && checksAttachment;
    };
    const hasPrivateModifier = (method: ts.MethodDeclaration): boolean =>
      (ts.getModifiers(method) ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword,
      );

    const candidates: {
      readonly className: string;
      readonly method: ts.MethodDeclaration;
      readonly methodName: string;
    }[] = [];
    for (const source of program.getSourceFiles()) {
      if (
        !source.fileName.startsWith(mediaRoot) ||
        source.fileName.endsWith('.spec.ts')
      ) {
        continue;
      }
      for (const statement of source.statements) {
        if (
          !ts.isClassDeclaration(statement) ||
          statement.name === undefined ||
          !hasStorageDependency(statement)
        ) {
          continue;
        }
        for (const member of statement.members) {
          if (
            ts.isMethodDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            member.body !== undefined &&
            !hasPrivateModifier(member) &&
            tracesCleanup(member)
          ) {
            candidates.push({
              className: statement.name.text,
              method: member,
              methodName: member.name.text,
            });
          }
        }
      }
    }
    const cleanupCandidates = candidates.filter(({ className }) =>
      className.includes('Cleanup'),
    );
    expect(
      cleanupCandidates.map(
        ({ className, methodName }) => `${className}.${methodName}`,
      ),
    ).toHaveLength(1);
    const candidate = cleanupCandidates[0];
    if (candidate === undefined) {
      throw new Error('Expired unattached media cleanup provider is missing');
    }

    let instance: Record<string, unknown> | undefined;
    for (const moduleRef of app.get(ModulesContainer).values()) {
      if (moduleRef.name !== 'MediaModule') continue;
      for (const wrapper of moduleRef.providers.values()) {
        const provided: unknown = wrapper.instance;
        if (!isRecord(provided)) continue;
        const constructor: unknown = provided['constructor'];
        if (
          typeof constructor === 'function' &&
          constructor.name === candidate.className
        ) {
          instance = provided;
        }
      }
    }
    if (instance === undefined) {
      throw new Error('Cleanup class is not registered in MediaModule');
    }
    const entry: unknown = instance[candidate.methodName];
    if (typeof entry !== 'function') {
      throw new Error('Cleanup provider entry method is unavailable');
    }
    const parameters = candidate.method.parameters;
    return {
      invoke: async (now) => {
        let arguments_: readonly unknown[];
        const parameter = parameters[0];
        if (parameter === undefined) {
          arguments_ = [];
        } else if (parameters.length !== 1) {
          throw new Error('Cleanup entry requires unsupported arguments');
        } else {
          const type = checker.getTypeAtLocation(parameter);
          const properties = new Set(
            checker.getPropertiesOfType(type).map(({ name }) => name),
          );
          if (properties.has('now')) {
            arguments_ = [{ now }];
          } else if (
            type.getSymbol()?.name === 'Date' ||
            checker.typeToString(type) === 'Date'
          ) {
            arguments_ = [now];
          } else if (
            parameter.questionToken !== undefined ||
            parameter.initializer !== undefined
          ) {
            arguments_ = [];
          } else {
            throw new Error('Cleanup entry has no supported clock input');
          }
        }
        const result = Reflect.apply(entry, instance, arguments_) as unknown;
        return Promise.resolve(result);
      },
    };
  }

  async function seedCleanupBatch(input: {
    readonly attached: boolean;
    readonly expired: boolean;
    readonly identity: TestIdentity;
    readonly status?: 'PENDING' | 'READY';
  }): Promise<{
    readonly assetId: string;
    readonly batchId: string;
    readonly key: ObjectStorageKey;
  }> {
    const batchId = randomUUID();
    const assetId = randomUUID();
    const expiresAt = new Date(
      Date.now() + (input.expired ? -60_000 : 24 * 60 * 60 * 1000),
    );
    const createdAt = new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000);
    const key = buildImportMediaObjectKey({
      workspaceId: input.identity.workspaceId,
      batchId,
      assetId,
      safeName: 'cleanup.png',
    });
    const status = input.status ?? (input.attached ? 'READY' : 'PENDING');
    const hasVerification = status === 'READY';
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId: input.identity.workspaceId,
        createdAt,
        expiresAt,
        ...(input.attached
          ? {
              attachedProjectId: input.identity.projectId,
              attachedAt: new Date(createdAt.getTime() + 60_000),
            }
          : {}),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId: input.identity.workspaceId,
        projectId: input.attached ? input.identity.projectId : null,
        importBatchId: batchId,
        objectKey: key,
        status,
        declaredFileName: 'cleanup.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: png.byteLength,
        declaredChecksumSha256: pngChecksum,
        ...(hasVerification
          ? {
              verifiedMimeType: 'image/png',
              verifiedSizeBytes: png.byteLength,
              verifiedWidth: 1,
              verifiedHeight: 1,
              verifiedChecksumSha256: pngChecksum,
              verifiedAt: new Date(),
            }
          : {}),
      },
    });
    storage.objects.set(key, png);
    return { assetId, batchId, key };
  }

  it('rejects foreign ownership before object access', async () => {
    const owner = await seedIdentity('completion-owner');
    const foreign = await seedIdentity('completion-foreign');
    const asset = await seedProjectAsset(owner, { status: 'PENDING' });
    const storage = new MemoryObjectStorage();
    storage.objects.set(asset.key, png);

    await expect(
      completion(storage).execute({
        workspaceId: foreign.workspaceId,
        assetId: asset.assetId,
        owner: { kind: 'project', projectId: foreign.projectId },
        actorUserId: foreign.userId,
        requestId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(storage.reads).toBe(0);
  });

  it.each([
    [
      'declaration mismatch',
      Buffer.from(png),
      'b'.repeat(64),
      'content-mismatch',
    ],
    [
      'truncated PNG with a valid signature',
      png.subarray(0, 12),
      createHash('sha256').update(png.subarray(0, 12)).digest('hex'),
      'invalid-image',
    ],
  ] as const)(
    'rejects %s, removes the untrusted object, and retains a cleanup record',
    async (_case, bytes, checksum, code) => {
      const identity = await seedIdentity('completion-integrity');
      const asset = await seedProjectAsset(identity, {
        status: 'PENDING',
        declaredChecksumSha256: checksum,
        declaredSizeBytes: bytes.byteLength,
      });
      const storage = new MemoryObjectStorage();
      storage.objects.set(asset.key, bytes);

      await expect(
        completion(storage).execute({
          workspaceId: identity.workspaceId,
          assetId: asset.assetId,
          owner: { kind: 'project', projectId: identity.projectId },
          actorUserId: identity.userId,
          requestId: randomUUID(),
        }),
      ).resolves.toEqual({ kind: 'rejected', code });
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.assetId } }),
      ).resolves.toMatchObject({ status: 'PENDING' });
      expect(storage.objects.has(asset.key)).toBe(false);
    },
  );

  it('rejects an oversized object without reading an unbounded body', async () => {
    const identity = await seedIdentity('completion-oversize');
    const asset = await seedProjectAsset(identity, { status: 'PENDING' });
    const storage = new MemoryObjectStorage();
    storage.oversized.add(asset.key);

    await expect(
      completion(storage).execute({
        workspaceId: identity.workspaceId,
        assetId: asset.assetId,
        owner: { kind: 'project', projectId: identity.projectId },
        actorUserId: identity.userId,
        requestId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'rejected', code: 'media-too-large' });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.assetId } }),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('rejects an expired unattached pending import before object access', async () => {
    const identity = await seedIdentity('completion-expired');
    const batchId = randomUUID();
    const assetId = randomUUID();
    const key = buildImportMediaObjectKey({
      workspaceId: identity.workspaceId,
      batchId,
      assetId,
      safeName: 'expired.png',
    });
    const expiresAt = new Date(Date.now() - 60_000);
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId: identity.workspaceId,
        createdAt: new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000),
        expiresAt,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId: identity.workspaceId,
        importBatchId: batchId,
        objectKey: key,
        status: 'PENDING',
        declaredFileName: 'expired.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: png.byteLength,
        declaredChecksumSha256: pngChecksum,
      },
    });
    const storage = new MemoryObjectStorage();
    storage.objects.set(key, png);

    await expect(
      completion(storage).execute({
        workspaceId: identity.workspaceId,
        assetId,
        owner: { kind: 'import', batchId },
        actorUserId: identity.userId,
        requestId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'expired' });
    expect(storage.reads).toBe(0);
  });

  it('reconciles expired objects behind durable tombstones while preserving live or attached batches', async () => {
    const identity = await seedIdentity('cleanup-batches');
    const staleProjectUpload = await seedProjectAsset(identity, {
      status: 'PENDING',
    });
    const liveProjectUpload = await seedProjectAsset(identity, {
      status: 'PENDING',
    });
    const deletingProjectAsset = await seedProjectAsset(identity, {
      status: 'DELETING',
    });
    storage.objects.set(staleProjectUpload.key, png);
    storage.objects.set(liveProjectUpload.key, png);
    storage.objects.set(deletingProjectAsset.key, png);
    await prisma.mediaAsset.update({
      where: { id: staleProjectUpload.assetId },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
    });
    const expired = await seedCleanupBatch({
      identity,
      expired: true,
      attached: false,
    });
    const expiredReady = await seedCleanupBatch({
      identity,
      expired: true,
      attached: false,
      status: 'READY',
    });
    const live = await seedCleanupBatch({
      identity,
      expired: false,
      attached: false,
    });
    const attached = await seedCleanupBatch({
      identity,
      expired: true,
      attached: true,
    });
    const controlRows = await Promise.all(
      [live, attached].map(async (control) => ({
        asset: await prisma.mediaAsset.findUniqueOrThrow({
          where: { id: control.assetId },
        }),
        batch: await prisma.mediaImportBatch.findUniqueOrThrow({
          where: { id: control.batchId },
        }),
        control,
      })),
    );
    const cleanup = discoverCleanupUseCase();

    await cleanup.invoke(new Date());

    for (const reconciled of [expired, expiredReady]) {
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({
          where: { id: reconciled.assetId },
        }),
      ).resolves.toMatchObject({ importBatchId: reconciled.batchId });
      const tombstone = await prisma.mediaImportBatch.findUniqueOrThrow({
        where: { id: reconciled.batchId },
      });
      expect(tombstone.cleanupStartedAt).toBeInstanceOf(Date);
      expect(tombstone.cleanupLastAttemptAt).toBeInstanceOf(Date);
      expect(storage.objects.has(reconciled.key)).toBe(false);
    }
    const staleTombstone = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: staleProjectUpload.assetId },
    });
    expect(staleTombstone.cleanupStartedAt).toBeInstanceOf(Date);
    expect(staleTombstone.cleanupLastAttemptAt).toBeInstanceOf(Date);
    expect(storage.objects.has(staleProjectUpload.key)).toBe(false);
    const deletingTombstone = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: deletingProjectAsset.assetId },
    });
    expect(deletingTombstone.cleanupStartedAt).toBeInstanceOf(Date);
    expect(deletingTombstone.cleanupLastAttemptAt).toBeInstanceOf(Date);
    expect(storage.objects.has(deletingProjectAsset.key)).toBe(false);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: liveProjectUpload.assetId },
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(storage.objects.get(liveProjectUpload.key)).toEqual(png);
    expect(storage.objects.get(live.key)).toEqual(png);
    expect(storage.objects.get(attached.key)).toEqual(png);
    for (const { asset, batch, control } of controlRows) {
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({
          where: { id: control.assetId },
        }),
      ).resolves.toEqual(asset);
      await expect(
        prisma.mediaImportBatch.findUniqueOrThrow({
          where: { id: control.batchId },
        }),
      ).resolves.toEqual(batch);
    }
  });

  it('reconciles a PUT that finishes after the first expired-batch DELETE', async () => {
    const identity = await seedIdentity('import-upload-late-finish');
    const batchId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId: identity.workspaceId,
        createdAt: new Date(expiresAt.getTime() - 24 * 60 * 60 * 1_000),
        expiresAt,
      },
    });

    const upload = await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/media/import-batches/${batchId}/uploads`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .send({
        fileName: 'settled.png',
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
        checksumSha256: pngChecksum,
      })
      .expect(201);
    const uploadBody: unknown = upload.body;
    if (!isRecord(uploadBody) || !isRecord(uploadBody['upload'])) {
      throw new Error('Import upload response is invalid');
    }
    const assetId = String(uploadBody['assetId']);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
    });
    const cleanup = discoverCleanupUseCase();
    const firstAttemptAt = new Date(expiresAt.getTime() + 1);

    await cleanup.invoke(firstAttemptAt);
    expect(
      storage.deletes.filter((key) => key === asset.objectKey),
    ).toHaveLength(1);
    const claimedBatch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    expect(claimedBatch.cleanupStartedAt).toEqual(firstAttemptAt);
    expect(claimedBatch.cleanupLastAttemptAt).toEqual(firstAttemptAt);

    // Models a PUT authenticated before URL expiry but committed after the first DELETE.
    storage.objects.set(asset.objectKey as ObjectStorageKey, png);
    const newExpiry = new Date(firstAttemptAt.getTime() + 30 * 60 * 1_000);
    await prisma.mediaImportBatch.createMany({
      data: Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        workspaceId: identity.workspaceId,
        createdAt: new Date(newExpiry.getTime() - 24 * 60 * 60 * 1_000),
        expiresAt: newExpiry,
      })),
    });
    const secondAttemptAt = new Date(
      firstAttemptAt.getTime() + 60 * 60 * 1_000,
    );
    await cleanup.invoke(secondAttemptAt);

    expect(storage.objects.has(asset.objectKey as ObjectStorageKey)).toBe(
      false,
    );
    expect(
      storage.deletes.filter((key) => key === asset.objectKey),
    ).toHaveLength(2);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
    ).resolves.toMatchObject({ importBatchId: batchId });
    const reconciledBatch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    expect(reconciledBatch.cleanupStartedAt).toEqual(firstAttemptAt);
    expect(reconciledBatch.cleanupLastAttemptAt).toEqual(secondAttemptAt);
  });

  it('persists an expired-batch cleanup claim and resumes after storage recovers', async () => {
    const identity = await seedIdentity('cleanup-batch-retry');
    const expired = await seedCleanupBatch({
      identity,
      expired: true,
      attached: false,
      status: 'READY',
    });
    storage.failedDeletes.add(expired.key);
    const cleanup = discoverCleanupUseCase();

    await expect(cleanup.invoke(new Date())).rejects.toThrow(
      'Media cleanup failed for 1 object(s)',
    );
    const claimedBatch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: expired.batchId },
    });
    expect(claimedBatch.cleanupStartedAt).toBeInstanceOf(Date);

    const claimedReplay = await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/media/import-batches/${expired.batchId}/media/${expired.assetId}/complete`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .expect(409);
    expect(errorCode(claimedReplay)).toBe('MEDIA_ASSET_NOT_READY');

    storage.failedDeletes.delete(expired.key);
    const recoveredAt = new Date(Date.now() + 60 * 60 * 1_000);
    await cleanup.invoke(recoveredAt);

    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: expired.assetId } }),
    ).resolves.toMatchObject({ importBatchId: expired.batchId });
    const reconciledBatch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: expired.batchId },
    });
    expect(reconciledBatch.cleanupStartedAt).toEqual(
      claimedBatch.cleanupStartedAt,
    );
    expect(reconciledBatch.cleanupLastAttemptAt).toEqual(recoveredAt);
    expect(storage.objects.has(expired.key)).toBe(false);
  });

  it('continues batch and project reconciliation after a poison object fails', async () => {
    const identity = await seedIdentity('cleanup-poison-isolation');
    const batchId = randomUUID();
    const expiresAt = new Date(Date.now() - 60_000);
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId: identity.workspaceId,
        createdAt: new Date(expiresAt.getTime() - 24 * 60 * 60 * 1_000),
        expiresAt,
      },
    });
    const poisonAssetId = '00000000-0000-4000-8000-000000000001';
    const healthyAssetId = '00000000-0000-4000-8000-000000000002';
    const poisonKey = buildImportMediaObjectKey({
      workspaceId: identity.workspaceId,
      batchId,
      assetId: poisonAssetId,
      safeName: 'poison.png',
    });
    const healthyKey = buildImportMediaObjectKey({
      workspaceId: identity.workspaceId,
      batchId,
      assetId: healthyAssetId,
      safeName: 'healthy.png',
    });
    for (const [id, objectKey, fileName] of [
      [poisonAssetId, poisonKey, 'poison.png'],
      [healthyAssetId, healthyKey, 'healthy.png'],
    ] as const) {
      await prisma.mediaAsset.create({
        data: {
          id,
          workspaceId: identity.workspaceId,
          importBatchId: batchId,
          objectKey,
          declaredFileName: fileName,
          declaredMimeType: 'image/png',
          declaredSizeBytes: png.byteLength,
          declaredChecksumSha256: pngChecksum,
        },
      });
      storage.objects.set(objectKey, png);
    }
    const staleProjectUpload = await seedProjectAsset(identity, {
      status: 'PENDING',
    });
    await prisma.mediaAsset.update({
      where: { id: staleProjectUpload.assetId },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
    });
    storage.objects.set(staleProjectUpload.key, png);
    storage.failedDeletes.add(poisonKey);

    await expect(discoverCleanupUseCase().invoke(new Date())).rejects.toThrow(
      'Media cleanup failed for 1 object(s)',
    );

    expect(storage.deletes).toContain(poisonKey);
    expect(storage.deletes).toContain(healthyKey);
    expect(storage.deletes).toContain(staleProjectUpload.key);
    expect(storage.objects.get(poisonKey)).toEqual(png);
    expect(storage.objects.has(healthyKey)).toBe(false);
    expect(storage.objects.has(staleProjectUpload.key)).toBe(false);
    const healthyTombstone = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: healthyAssetId },
    });
    const projectTombstone = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: staleProjectUpload.assetId },
    });
    expect(healthyTombstone.cleanupLastAttemptAt).toBeInstanceOf(Date);
    expect(projectTombstone.cleanupLastAttemptAt).toBeInstanceOf(Date);
  });

  it('bounds each cleanup run and reserves attempts for both object queues', async () => {
    const identity = await seedIdentity('cleanup-global-budget');
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 60_000);
    const batchId = randomUUID();
    await prisma.mediaImportBatch.create({
      data: {
        id: batchId,
        workspaceId: identity.workspaceId,
        createdAt: new Date(expiresAt.getTime() - 24 * 60 * 60 * 1_000),
        expiresAt,
      },
    });
    const importAssets = Array.from({ length: 40 }, (_, index) => {
      const id = randomUUID();
      return {
        id,
        key: buildImportMediaObjectKey({
          workspaceId: identity.workspaceId,
          batchId,
          assetId: id,
          safeName: `import-${String(index)}.png`,
        }),
      };
    });
    const projectAssets = Array.from({ length: 40 }, (_, index) => {
      const id = randomUUID();
      return {
        id,
        key: buildProjectMediaObjectKey({
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          assetId: id,
          safeName: `project-${String(index)}.png`,
        }),
      };
    });
    await prisma.mediaAsset.createMany({
      data: [
        ...importAssets.map(({ id, key }) => ({
          id,
          workspaceId: identity.workspaceId,
          importBatchId: batchId,
          objectKey: key,
          declaredFileName: 'import.png',
          declaredMimeType: 'image/png',
          declaredSizeBytes: png.byteLength,
          declaredChecksumSha256: pngChecksum,
        })),
        ...projectAssets.map(({ id, key }) => ({
          id,
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          objectKey: key,
          declaredFileName: 'project.png',
          declaredMimeType: 'image/png',
          declaredSizeBytes: png.byteLength,
          declaredChecksumSha256: pngChecksum,
          createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1_000),
        })),
      ],
    });
    for (const { key } of [...importAssets, ...projectAssets]) {
      storage.objects.set(key, png);
    }

    await discoverCleanupUseCase().invoke(now);

    expect(storage.deletes).toHaveLength(60);
    expect(
      importAssets.filter(({ key }) => !storage.objects.has(key)),
    ).toHaveLength(30);
    expect(
      projectAssets.filter(({ key }) => !storage.objects.has(key)),
    ).toHaveLength(30);
  });

  it('completes once and returns persisted evidence idempotently', async () => {
    const identity = await seedIdentity('completion-idempotent');
    const asset = await seedProjectAsset(identity, { status: 'PENDING' });
    const storage = new MemoryObjectStorage();
    storage.objects.set(asset.key, png);
    const useCase = completion(storage);
    const input = {
      workspaceId: identity.workspaceId,
      assetId: asset.assetId,
      owner: { kind: 'project' as const, projectId: identity.projectId },
      actorUserId: identity.userId,
      requestId: randomUUID(),
    };

    const first = await useCase.execute(input);
    const replay = await useCase.execute({ ...input, requestId: randomUUID() });

    expect(first).toMatchObject({ kind: 'ready', transition: 'completed' });
    expect(replay).toMatchObject({
      kind: 'ready',
      transition: 'already-ready',
    });
    if (first.kind !== 'ready' || replay.kind !== 'ready') {
      throw new Error('Expected READY completion results');
    }
    expect(replay.verification).toEqual(first.verification);
    expect(storage.reads).toBe(1);
  });

  it('creates, completes, and lists a project upload without exposing storage coordinates', async () => {
    const identity = await seedIdentity('project-upload-api');
    const upload = await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/media/uploads`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .send({
        fileName: 'hero.png',
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
        checksumSha256: pngChecksum,
      })
      .expect(201);
    expect(upload.body).toMatchObject({
      status: 'PENDING',
      upload: {
        method: 'PUT',
        requiredHeaders: {
          'content-type': 'image/png',
          'if-none-match': '*',
        },
      },
    });
    const uploadBody: unknown = upload.body;
    if (!isRecord(uploadBody)) throw new Error('Upload response is invalid');
    const assetId: unknown = uploadBody['assetId'];
    expect(typeof assetId).toBe('string');
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: String(assetId) },
    });
    storage.objects.set(asset.objectKey as ObjectStorageKey, png);

    await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/media/${String(assetId)}/complete`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          assetId,
          status: 'READY',
          mimeType: 'image/png',
          sizeBytes: png.byteLength,
          width: 1,
          height: 1,
        });
      });

    const listed = await request(app.getHttpServer())
      .get(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/media`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .expect(200);
    const listedBody: unknown = listed.body;
    if (!isRecord(listedBody) || !Array.isArray(listedBody['items'])) {
      throw new Error('Media list response is invalid');
    }
    expect(listedBody['items']).toEqual([
      expect.objectContaining({ assetId, status: 'READY' }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(asset.objectKey);
    expect(listedBody['items'][0]).not.toHaveProperty('checksumSha256');
  });

  it('creates and completes an unattached import-batch upload', async () => {
    const identity = await seedIdentity('import-upload-api');
    const batch = await request(app.getHttpServer())
      .post(`/v1/workspaces/${identity.workspaceId}/media/import-batches`)
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .expect(201);
    const batchBody: unknown = batch.body;
    if (!isRecord(batchBody)) throw new Error('Batch response is invalid');
    const batchId: unknown = batchBody['batchId'];
    expect(typeof batchId).toBe('string');

    const upload = await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/media/import-batches/${String(batchId)}/uploads`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .send({
        fileName: 'legacy.png',
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
        checksumSha256: pngChecksum,
      })
      .expect(201);
    const uploadBody: unknown = upload.body;
    if (!isRecord(uploadBody)) throw new Error('Upload response is invalid');
    const assetId: unknown = uploadBody['assetId'];
    expect(typeof assetId).toBe('string');
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: String(assetId) },
    });
    expect(asset.projectId).toBeNull();
    expect(asset.importBatchId).toBe(batchId);
    storage.objects.set(asset.objectKey as ObjectStorageKey, png);

    await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/media/import-batches/${String(batchId)}/media/${String(assetId)}/complete`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ assetId, status: 'READY' });
      });

    const created = await request(app.getHttpServer())
      .post(`/v1/workspaces/${identity.workspaceId}/projects`)
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Imported media project',
        siteConfig: managedConfig(String(assetId)),
        mediaImportBatchId: batchId,
      })
      .expect(201);
    const createdBody: unknown = created.body;
    if (!isRecord(createdBody)) {
      throw new Error('Create project response is invalid');
    }
    const projectId: unknown = createdBody['id'];
    const publicSlug: unknown = createdBody['publicSlug'];
    expect(typeof projectId).toBe('string');
    expect(typeof publicSlug).toBe('string');
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: String(assetId) } }),
    ).resolves.toMatchObject({ projectId });
    const attachedBatch = await prisma.mediaImportBatch.findUniqueOrThrow({
      where: { id: String(batchId) },
    });
    expect(attachedBatch).toMatchObject({ attachedProjectId: projectId });
    expect(attachedBatch.attachedAt).toBeInstanceOf(Date);

    for (const completeUrl of [
      `/v1/workspaces/${identity.workspaceId}/projects/${String(projectId)}/media/${String(assetId)}/complete`,
      `/v1/workspaces/${identity.workspaceId}/media/import-batches/${String(batchId)}/media/${String(assetId)}/complete`,
    ]) {
      await request(app.getHttpServer())
        .post(completeUrl)
        .set('Authorization', `Bearer ${identity.accessToken}`)
        .set('Origin', allowedOrigin)
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({ assetId, status: 'READY' });
        });
    }

    await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${String(projectId)}/publish`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 1,
        siteConfig: managedConfig(String(assetId)),
      })
      .expect(200);

    await expect(
      prisma.release.count({ where: { projectId: String(projectId) } }),
    ).resolves.toBe(1);

    const publicSite = await request(app.getHttpServer())
      .get(`/v1/public/sites/${String(publicSlug)}`)
      .expect(200);
    const serializedPublicSite = JSON.stringify(publicSite.body);
    expect(serializedPublicSite).toContain(
      `https://storage.example.test/workspaces/${identity.workspaceId}/imports/${String(batchId)}/${String(assetId)}/legacy.png?signature=test`,
    );
    expect(serializedPublicSite).not.toContain('"assetId"');
    expect(serializedPublicSite).not.toContain('"kind":"managed"');
    expect(serializedPublicSite).not.toContain('"objectKey"');
  });

  it('publishes and atomically activates v5 only when every managed asset is ready and intact', async () => {
    const identity = await seedIdentity('publish-ready');
    const asset = await seedProjectAsset(identity);
    storage.objects.set(asset.key, png);

    const response = await publish(identity, asset.assetId);

    expect(response.status).toBe(200);
    await expect(releaseState(identity)).resolves.toEqual({
      active: 1,
      releases: 1,
      revisions: 2,
    });
  });

  it('returns the stable not-ready conflict for a schema-valid non-UUID asset id', async () => {
    const identity = await seedIdentity('publish-non-uuid');

    const response = await publish(identity, 'asset-managed-1');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: 'MEDIA_ASSET_NOT_READY' },
    });
    await expect(releaseState(identity)).resolves.toEqual({
      active: 0,
      releases: 0,
      revisions: 1,
    });
  });

  it.each([
    ['PENDING', { status: 'PENDING' }],
    ['DELETING', { status: 'DELETING' }],
  ] satisfies readonly (readonly [string, AssetEvidenceOverride])[])(
    'returns stable 409 and cannot activate a release for %s evidence',
    async (_case, override) => {
      const identity = await seedIdentity('publish-invalid');
      const asset = await seedProjectAsset(identity, override);
      storage.objects.set(asset.key, png);

      const response = await publishWithoutProjectMutation(
        identity,
        asset.assetId,
      );

      await expect(releaseState(identity)).resolves.toEqual({
        active: 0,
        releases: 0,
        revisions: 1,
      });
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('MEDIA_ASSET_NOT_READY');
    },
  );

  it.each([
    ['missing object', 'missing'],
    ['truncated PNG with supported signature', 'truncated'],
    ['MIME/magic mismatch', 'mime'],
    ['byte/checksum mismatch', 'bytes'],
    ['decoded-dimension mismatch', 'dimensions'],
    ['decoded dimensions above the limit', 'dimensions-exceeded'],
    ['object above the byte limit', 'oversize'],
  ] as const)(
    'returns stable 409 and performs no publish writes for %s',
    async (_case, corruption) => {
      const identity = await seedIdentity('publish-integrity');
      const asset = await seedProjectAsset(identity);
      if (corruption === 'truncated') {
        storage.objects.set(asset.key, png.subarray(0, 12));
      } else if (corruption === 'mime') {
        storage.objects.set(asset.key, png);
        publishInspector.control(png, {
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
        });
      } else if (corruption === 'bytes') {
        storage.objects.set(asset.key, alternatePng);
      } else if (corruption === 'dimensions') {
        storage.objects.set(asset.key, png);
        publishInspector.control(png, {
          mimeType: 'image/png',
          width: 2,
          height: 2,
        });
      } else if (corruption === 'dimensions-exceeded') {
        storage.objects.set(asset.key, png);
        publishInspector.control(png, {
          mimeType: 'image/png',
          width: 12_001,
          height: 1,
        });
      } else if (corruption === 'oversize') {
        storage.oversized.add(asset.key);
      }

      const response = await publishWithoutProjectMutation(
        identity,
        asset.assetId,
      );

      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('MEDIA_ASSET_NOT_READY');
      await expect(releaseState(identity)).resolves.toEqual({
        active: 0,
        releases: 0,
        revisions: 1,
      });
    },
  );

  it('traverses a managed reference outside the first page/block before any publish write', async () => {
    const identity = await seedIdentity('publish-non-first');
    const first = await seedProjectAsset(identity);
    const nonFirst = await seedProjectAsset(identity, { status: 'PENDING' });
    storage.objects.set(first.key, png);

    const response = await publishWithoutProjectMutation(
      identity,
      first.assetId,
      nonFirst.assetId,
    );

    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe('MEDIA_ASSET_NOT_READY');
    await expect(releaseState(identity)).resolves.toEqual({
      active: 0,
      releases: 0,
      revisions: 1,
    });
  });

  it.each([
    'PENDING',
    'DELETING',
    'missing',
    'foreign-workspace',
    'foreign-project',
  ] as const)(
    'does not activate an immutable v5 release that references a %s asset',
    async (assetCase) => {
      const identity = await seedIdentity('activate-invalid');
      const valid = await seedProjectAsset(identity);
      storage.objects.set(valid.key, png);
      const baselineRelease = await prisma.release.create({
        data: {
          projectId: identity.projectId,
          operationId: randomUUID(),
          version: 1,
          siteConfig: fixture('v4-minimal-valid.json'),
          schemaVersion: 4,
        },
      });
      await prisma.activeRelease.create({
        data: {
          projectId: identity.projectId,
          releaseId: baselineRelease.id,
        },
      });
      let assetId = randomUUID();
      if (assetCase === 'PENDING' || assetCase === 'DELETING') {
        const invalid = await seedProjectAsset(identity, { status: assetCase });
        assetId = invalid.assetId;
        storage.objects.set(invalid.key, png);
      }
      if (assetCase === 'foreign-workspace') {
        const foreign = await seedIdentity('activate-foreign');
        const invalid = await seedProjectAsset(foreign);
        assetId = invalid.assetId;
        storage.objects.set(invalid.key, png);
      }
      if (assetCase === 'foreign-project') {
        const foreignProjectId = randomUUID();
        const initial = fixture('v4-minimal-valid.json');
        const operationId = randomUUID();
        await prisma.project.create({
          data: {
            id: foreignProjectId,
            workspaceId: identity.workspaceId,
            createOperationId: operationId,
            name: 'Activation foreign project',
            publicSlug: `activation-foreign-${randomUUID()}`,
            draft: initial,
            draftSchemaVersion: 4,
            revisions: {
              create: {
                operationId,
                version: 1,
                siteConfig: initial,
                schemaVersion: 4,
              },
            },
          },
        });
        const invalid = await seedProjectAsset(identity, {
          projectId: foreignProjectId,
        });
        assetId = invalid.assetId;
        storage.objects.set(invalid.key, png);
      }
      const release = await prisma.release.create({
        data: {
          projectId: identity.projectId,
          operationId: randomUUID(),
          version: 2,
          siteConfig: managedConfig(valid.assetId, assetId),
          schemaVersion: 5,
        },
      });

      const response = await activate(identity, release.id);

      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('MEDIA_ASSET_NOT_READY');
      await expect(
        prisma.activeRelease.findUniqueOrThrow({
          where: { projectId: identity.projectId },
          select: { releaseId: true },
        }),
      ).resolves.toEqual({ releaseId: baselineRelease.id });
    },
  );

  it.each(['missing', 'foreign workspace', 'foreign project'] as const)(
    'returns stable 409 and cannot activate a release for a %s asset',
    async (ownershipCase) => {
      const identity = await seedIdentity('publish-owner');
      let assetId = randomUUID();
      if (ownershipCase === 'foreign workspace') {
        const foreign = await seedIdentity('publish-foreign-workspace');
        const invalid = await seedProjectAsset(foreign);
        assetId = invalid.assetId;
        storage.objects.set(invalid.key, png);
      }
      if (ownershipCase === 'foreign project') {
        const foreignProjectId = randomUUID();
        const initial = fixture('v4-minimal-valid.json');
        const operationId = randomUUID();
        await prisma.project.create({
          data: {
            id: foreignProjectId,
            workspaceId: identity.workspaceId,
            createOperationId: operationId,
            name: 'Foreign project',
            publicSlug: `foreign-${randomUUID()}`,
            draft: initial,
            draftSchemaVersion: 4,
            revisions: {
              create: {
                operationId,
                version: 1,
                siteConfig: initial,
                schemaVersion: 4,
              },
            },
          },
        });
        const invalid = await seedProjectAsset(identity, {
          projectId: foreignProjectId,
        });
        assetId = invalid.assetId;
        storage.objects.set(invalid.key, png);
      }

      const response = await publishWithoutProjectMutation(identity, assetId);

      await expect(releaseState(identity)).resolves.toEqual({
        active: 0,
        releases: 0,
        revisions: 1,
      });
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('MEDIA_ASSET_NOT_READY');
    },
  );
});
