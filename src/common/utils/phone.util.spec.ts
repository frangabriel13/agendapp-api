import { hasComparablePhone, normalizePhone } from './phone.util';

describe('normalizePhone', () => {
  it('saca todo lo que no sea dígito', () => {
    expect(normalizePhone('11 5555-1234')).toBe('1155551234');
    expect(normalizePhone('(011) 5555.1234')).toBe('1155551234');
  });

  /** El caso que justifica que exista la columna. */
  it.each([
    ['1155551234', 'sin prefijo'],
    ['01155551234', 'con 0 de larga distancia'],
    ['+54 11 5555-1234', 'con código de país'],
    ['+54 9 11 5555-1234', 'con código de país y 9 de celular'],
    ['54 9 11 5555 1234', 'sin el más'],
  ])('reconoce %s (%s) como el mismo número', (input) => {
    expect(normalizePhone(input)).toBe('1155551234');
  });

  it('deja los números cortos como están', () => {
    expect(normalizePhone('4444-5555')).toBe('44445555');
  });

  it('devuelve vacío si no hay ningún dígito', () => {
    expect(normalizePhone('no tiene')).toBe('');
    expect(hasComparablePhone('no tiene')).toBe(false);
  });

  /**
   * Límite asumido: el `15` viejo entra en los últimos 10 dígitos, así que este
   * formato no se empareja con el internacional. Está documentado en el util;
   * el test lo fija para que el día que se cambie por libphonenumber se vea.
   */
  it('NO reconoce el 15 viejo como el mismo número', () => {
    expect(normalizePhone('011 15 5555-1234')).not.toBe('1155551234');
  });
});
