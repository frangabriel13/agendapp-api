import {
  dateToTimeOfDay,
  dateToTimeOfDayOrNull,
  timeOfDayToDate,
  timeOfDayToMinutes,
} from './time-of-day.util';

describe('time-of-day.util', () => {
  describe('timeOfDayToDate', () => {
    it('ancla la hora al 1970-01-01 en UTC', () => {
      expect(timeOfDayToDate('09:30').toISOString()).toBe(
        '1970-01-01T09:30:00.000Z',
      );
    });

    it('acepta los bordes del día', () => {
      expect(timeOfDayToDate('00:00').toISOString()).toBe(
        '1970-01-01T00:00:00.000Z',
      );
      expect(timeOfDayToDate('23:59').toISOString()).toBe(
        '1970-01-01T23:59:00.000Z',
      );
    });

    it.each(['24:00', '09:60', '9:30', '0930', '', 'mediodía'])(
      'rechaza %p',
      (value) => {
        expect(() => timeOfDayToDate(value)).toThrow(RangeError);
      },
    );
  });

  describe('dateToTimeOfDay', () => {
    it('vuelve al string original', () => {
      expect(dateToTimeOfDay(timeOfDayToDate('18:00'))).toBe('18:00');
    });

    /**
     * El día ancla no se mira nunca: lo único que importa es la hora. Si
     * alguien guarda un TIME con otra fecha, la respuesta sigue siendo la hora.
     */
    it('ignora la fecha que traiga el Date', () => {
      expect(dateToTimeOfDay(new Date('2026-08-12T07:05:00.000Z'))).toBe(
        '07:05',
      );
    });

    it('deja pasar el null de los días cerrados', () => {
      expect(dateToTimeOfDayOrNull(null)).toBeNull();
    });
  });

  describe('timeOfDayToMinutes', () => {
    it('convierte a minutos desde medianoche', () => {
      expect(timeOfDayToMinutes('00:00')).toBe(0);
      expect(timeOfDayToMinutes('09:30')).toBe(570);
      expect(timeOfDayToMinutes('23:59')).toBe(1439);
    });

    it('ordena las horas como corresponde', () => {
      expect(timeOfDayToMinutes('09:00')).toBeLessThan(
        timeOfDayToMinutes('18:00'),
      );
    });
  });
});
