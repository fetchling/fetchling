export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a dotted path such as "arguments.path". Returns undefined if any step is missing. */
export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Read one key from a message's `params._meta`, or a result's `_meta`. */
export function metaValue(holder: unknown, key: string): unknown {
  if (!isObject(holder)) return undefined;
  const meta = holder._meta;
  return isObject(meta) ? meta[key] : undefined;
}

/** Structural equality for JSON values; key order does not matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}
