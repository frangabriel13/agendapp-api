/** Largo máximo del slug generado. La columna admite 63 (límite de un label DNS,
 * porque el slug se usa como subdominio); dejamos margen para el sufijo `-2`. */
const MAX_SLUG_LENGTH = 50;

/** Rango Unicode de los diacríticos combinantes que deja `normalize('NFD')`. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Slugs que no se pueden usar porque chocan con rutas o subdominios propios.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'blog',
  'dashboard',
  'docs',
  'health',
  'mail',
  'public',
  'soporte',
  'static',
  'support',
  'www',
]);

/**
 * Convierte texto libre en un slug apto para URL/subdominio.
 * `"Peluquería Ana & Co."` → `"peluqueria-ana-co"`.
 *
 * Devuelve string vacío si la entrada no tiene ningún caracter aprovechable
 * (ej. `"※※※"`); el caller decide el fallback.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '') // "í" → "i"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
