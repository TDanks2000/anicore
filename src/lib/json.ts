export function toJsonArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

export function fromJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
