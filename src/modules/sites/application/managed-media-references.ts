function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function managedMediaAssetIds(document: unknown): readonly string[] {
  const assetIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value['kind'] === 'managed' && typeof value['assetId'] === 'string') {
      assetIds.add(value['assetId']);
    }
    Object.values(value).forEach(visit);
  };
  visit(document);
  return [...assetIds].sort((left, right) => left.localeCompare(right));
}
