import { paginationMeta, resolvePagination } from './pagination.dto';

describe('resolvePagination', () => {
  it('sin query arranca en la página 1 con 20 por página', () => {
    expect(resolvePagination({})).toEqual({
      page: 1,
      pageSize: 20,
      skip: 0,
      take: 20,
    });
  });

  /** La página 1 no salta nada: el off-by-one clásico de la paginación. */
  it('la página 3 saltea las dos anteriores', () => {
    expect(resolvePagination({ page: 3, pageSize: 10 })).toMatchObject({
      skip: 20,
      take: 10,
    });
  });
});

describe('paginationMeta', () => {
  it('redondea las páginas para arriba', () => {
    expect(paginationMeta(45, { page: 1, pageSize: 20 })).toEqual({
      page: 1,
      pageSize: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('sin resultados son 0 páginas, no 1', () => {
    expect(paginationMeta(0, { page: 1, pageSize: 20 })).toMatchObject({
      totalPages: 0,
    });
  });
});
