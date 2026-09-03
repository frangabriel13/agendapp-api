import { shouldExposeDocs } from './security-headers';

describe('shouldExposeDocs', () => {
  it('en desarrollo y en test se publica', () => {
    expect(shouldExposeDocs('development')).toBe(true);
    expect(shouldExposeDocs('test')).toBe(true);
  });

  /** Publica el mapa completo de la API a cualquiera que pase. */
  it('en producción no', () => {
    expect(shouldExposeDocs('production')).toBe(false);
  });

  /**
   * El default importa: si algún día `NODE_ENV` llega vacío o con un valor
   * raro, el error barato es exponer la documentación de más, no romper el
   * arranque. La decisión es deliberada — solo `production` la esconde.
   */
  it('un valor desconocido publica, no rompe', () => {
    expect(shouldExposeDocs('')).toBe(true);
    expect(shouldExposeDocs('staging')).toBe(true);
  });
});
