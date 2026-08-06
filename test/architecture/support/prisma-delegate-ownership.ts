import ts from 'typescript';

const delegateOwners: Readonly<Record<string, string>> = {
  user: 'auth',
  refreshSession: 'auth',
  emailVerificationToken: 'auth',
  passwordResetToken: 'auth',
  workspace: 'workspaces',
  membership: 'workspaces',
  project: 'sites',
  projectRevision: 'sites',
  release: 'sites',
  activeRelease: 'sites',
  siteConfigRolloutState: 'sites',
  mediaAsset: 'media',
  mediaImportBatch: 'media',
  lead: 'forms',
  outbox: 'notifications',
  resendWebhookReceipt: 'notifications',
  idempotencyRecord: 'shared/idempotency',
  auditSequence: 'shared/audit',
  auditEvent: 'shared/audit',
};

const writeOperations = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'delete',
  'deleteMany',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);

export interface PrismaDelegateWrite {
  readonly delegate: string;
  readonly operation: string;
  readonly owner: string;
}

function accessedProperty(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

export function collectPrismaDelegateWrites(
  sourceFile: ts.SourceFile,
): PrismaDelegateWrite[] {
  const writes: PrismaDelegateWrite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const operation = accessedProperty(node.expression);
      const delegateExpression =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
      const delegate =
        delegateExpression === undefined
          ? undefined
          : accessedProperty(delegateExpression);
      const owner =
        delegate === undefined ? undefined : delegateOwners[delegate];
      if (
        operation !== undefined &&
        writeOperations.has(operation) &&
        delegate !== undefined &&
        owner !== undefined
      ) {
        writes.push({ delegate, operation, owner });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return writes;
}
