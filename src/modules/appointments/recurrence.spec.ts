import { RecurrenceFrequency } from '@prisma/client';
import { recurrenceDates } from './recurrence';

const { WEEKLY, BIWEEKLY, MONTHLY } = RecurrenceFrequency;

describe('recurrenceDates', () => {
  it('la primera fecha es la que se pidió', () => {
    expect(recurrenceDates('2026-09-07', WEEKLY, 1)).toEqual(['2026-09-07']);
  });

  it('semanal: los lunes seguidos', () => {
    expect(recurrenceDates('2026-09-07', WEEKLY, 4)).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
  });

  it('quincenal: uno por medio', () => {
    expect(recurrenceDates('2026-09-07', BIWEEKLY, 3)).toEqual([
      '2026-09-07',
      '2026-09-21',
      '2026-10-05',
    ]);
  });

  it('mensual: el mismo día de cada mes', () => {
    expect(recurrenceDates('2026-09-15', MONTHLY, 4)).toEqual([
      '2026-09-15',
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
    ]);
  });

  it('cruza el fin de año', () => {
    expect(recurrenceDates('2026-12-20', WEEKLY, 3)).toEqual([
      '2026-12-20',
      '2026-12-27',
      '2027-01-03',
    ]);
  });

  it('mensual cruzando el fin de año', () => {
    expect(recurrenceDates('2026-11-10', MONTHLY, 4)).toEqual([
      '2026-11-10',
      '2026-12-10',
      '2027-01-10',
      '2027-02-10',
    ]);
  });

  describe('meses que no tienen ese día', () => {
    /** El 31 de enero más un mes no es el 3 de marzo. */
    it('recorta al último día del mes', () => {
      expect(recurrenceDates('2027-01-31', MONTHLY, 4)).toEqual([
        '2027-01-31',
        '2027-02-28',
        '2027-03-31',
        '2027-04-30',
      ]);
    });

    it('en año bisiesto febrero llega al 29', () => {
      expect(recurrenceDates('2028-01-31', MONTHLY, 2)).toEqual([
        '2028-01-31',
        '2028-02-29',
      ]);
    });

    /**
     * El recorte no se arrastra: después de un febrero corto, marzo vuelve al
     * día original. Si se fuera recalculando desde la fecha anterior, la serie
     * se iría corriendo hacia atrás mes a mes.
     */
    it('el recorte de un mes no arrastra a los siguientes', () => {
      expect(recurrenceDates('2027-01-30', MONTHLY, 3)).toEqual([
        '2027-01-30',
        '2027-02-28',
        '2027-03-30',
      ]);
    });
  });

  /**
   * La razón de que esto sea calendario puro y no sumar horas: si la serie
   * cruza un cambio de hora, sumar 168 horas correría el turno una hora. Acá se
   * suman **días**, y la hora se pega después con la zona del negocio.
   */
  it('semanal cruzando un cambio de horario da los mismos días', () => {
    // En Madrid el horario de verano arranca el 29/3/2027.
    expect(recurrenceDates('2027-03-22', WEEKLY, 3)).toEqual([
      '2027-03-22',
      '2027-03-29',
      '2027-04-05',
    ]);
  });

  it('rechaza una serie vacía', () => {
    expect(() => recurrenceDates('2026-09-07', WEEKLY, 0)).toThrow(RangeError);
  });
});
