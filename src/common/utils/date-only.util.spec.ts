import { dateOnlyToDate, dateToDateOnly } from './date-only.util';

describe('date-only.util', () => {
  describe('dateOnlyToDate', () => {
    it('ancla la fecha a medianoche UTC', () => {
      expect(dateOnlyToDate('2026-12-25').toISOString()).toBe(
        '2026-12-25T00:00:00.000Z',
      );
    });

    it('acepta el 29 de febrero de un año bisiesto', () => {
      expect(dateOnlyToDate('2028-02-29').toISOString()).toBe(
        '2028-02-29T00:00:00.000Z',
      );
    });

    /**
     * `new Date('2026-02-30')` no explota: JS lo corre al 2 de marzo. Sin el
     * chequeo de ida y vuelta, el feriado terminaría cargado en otro día.
     */
    it('rechaza un día que no existe en vez de correrlo', () => {
      expect(() => dateOnlyToDate('2026-02-30')).toThrow(RangeError);
      expect(() => dateOnlyToDate('2026-02-29')).toThrow(RangeError);
    });

    it.each(['2026-13-01', '2026-00-10', '26-12-25', '2026/12/25', 'hoy'])(
      'rechaza %p',
      (value) => {
        expect(() => dateOnlyToDate(value)).toThrow(RangeError);
      },
    );
  });

  describe('dateToDateOnly', () => {
    it('vuelve al string original', () => {
      expect(dateToDateOnly(dateOnlyToDate('2026-12-25'))).toBe('2026-12-25');
    });

    /**
     * El caso que rompe si se usan métodos locales en vez de UTC: en
     * Buenos Aires (UTC-3) `getDate()` sobre esta fecha devuelve el 24.
     */
    it('no corre la fecha por la zona horaria', () => {
      expect(dateToDateOnly(new Date('2026-12-25T00:00:00.000Z'))).toBe(
        '2026-12-25',
      );
    });
  });
});
