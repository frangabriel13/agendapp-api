import { isReservedSlug, slugify } from './slug.util';

describe('slugify', () => {
  it('saca acentos, mayúsculas y símbolos', () => {
    expect(slugify('Peluquería Ana & Co.')).toBe('peluqueria-ana-co');
  });

  it('colapsa separadores y recorta los guiones de los extremos', () => {
    expect(slugify('  --Estética   María--  ')).toBe('estetica-maria');
  });

  it('devuelve string vacío si no queda ningún caracter usable', () => {
    expect(slugify('※※※')).toBe('');
  });

  it('trunca a 50 caracteres sin dejar un guión colgando', () => {
    const result = slugify(`${'a'.repeat(49)} barbería`);

    expect(result).toBe('a'.repeat(49));
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('mantiene los números', () => {
    expect(slugify('Barbería 24hs')).toBe('barberia-24hs');
  });
});

describe('isReservedSlug', () => {
  it('detecta los slugs reservados de la plataforma', () => {
    expect(isReservedSlug('api')).toBe(true);
    expect(isReservedSlug('admin')).toBe(true);
  });

  it('deja pasar un nombre de negocio normal', () => {
    expect(isReservedSlug('peluqueria-ana-co')).toBe(false);
  });
});
