export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slugs to try, in order, for a new record: the bare title, then the title
 * qualified by a stable discriminator (such as a provider ID), then numbered
 * variants. Titles with no Latin characters fall back to the discriminator.
 */
export function* slugCandidates(title: string, discriminator?: string): Generator<string> {
  const qualifier = discriminator ? slugify(discriminator) : "";
  const base = slugify(title) || qualifier || "anime";

  yield base;
  const qualified = qualifier && qualifier !== base ? `${base}-${qualifier}` : base;
  if (qualified !== base) yield qualified;
  for (let suffix = 2; ; suffix++) yield `${qualified}-${suffix}`;
}
