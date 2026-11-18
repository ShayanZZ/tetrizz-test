const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML element content and for quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}
