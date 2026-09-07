import {
  aDiasDeHoy,
  enHorarioDe,
  masDias,
  masMeses,
  primerDiaDelMes,
  proximoLunes,
  ultimoDiaDelMes,
} from './utils/fechas';

/**
 * Los invariantes de `utils/fechas.ts`.
 *
 * No toca la base ni levanta la app: vive acá porque el jest de unitarios tiene
 * `rootDir: src` y no mira esta carpeta, y este archivo tiene que correr en CI
 * sí o sí. Es el que impide que el arreglo de las fechas se pudra igual que las
 * fechas que arregló.
 *
 * La forma de probarlo es correr el reloj: se simulan dos años de "hoy", uno
 * por día, y se exige que las propiedades valgan **todos** los días. Un test
 * que corriera con el reloj de verdad probaría un solo día —justamente lo que
 * dejó pasar el bug original—.
 */

const DIAS_SIMULADOS = 730;
const LUNES = 1;
const MS_POR_DIA = 24 * 60 * 60 * 1_000;

/**
 * Las horas del día a las que se simula cada jornada.
 *
 * Las dos importan y por motivos distintos: a las 01:19 UTC en Buenos Aires
 * todavía es el día anterior, que es justo donde una cuenta hecha sobre la
 * fecha UTC se corre un día; a las 13:19 las dos fechas coinciden.
 */
const HORAS_UTC = [1, 13];

const diaDeLaSemana = (fecha: string): number =>
  new Date(`${fecha}T00:00:00.000Z`).getUTCDay();

const diaDelMes = (fecha: string): number =>
  new Date(`${fecha}T00:00:00.000Z`).getUTCDate();

/** Días de calendario entre dos fechas, sin horas de por medio. */
const distanciaEnDias = (desde: string, hasta: string): number =>
  Math.round(
    (Date.parse(`${hasta}T00:00:00.000Z`) -
      Date.parse(`${desde}T00:00:00.000Z`)) /
      MS_POR_DIA,
  );

/** Hoy en Buenos Aires, que es lo que mira `proximoLunes()`. */
const hoyEnBuenosAires = (): string =>
  new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString().slice(0, 10);

describe('Fechas de los tests (e2e)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Corre `revisar` una vez por día simulado y devuelve los días en los que
   * algo no dio.
   *
   * Junta todos los incumplimientos en vez de cortar en el primero: si algo
   * falla un día de cada treinta, el listado dice cuáles, y eso es la mitad del
   * diagnóstico.
   */
  function diasQueFallan(
    revisar: (hoy: string) => string | null,
  ): { hoy: string; motivo: string }[] {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    const fallas: { hoy: string; motivo: string }[] = [];

    for (const hora of HORAS_UTC) {
      for (let dia = 0; dia < DIAS_SIMULADOS; dia += 1) {
        jest.setSystemTime(Date.UTC(2026, 0, 7, hora, 19) + dia * MS_POR_DIA);

        const hoy = hoyEnBuenosAires();
        const motivo = revisar(hoy);

        if (motivo !== null) {
          fallas.push({ hoy, motivo });
        }
      }
    }

    return fallas;
  }

  describe('proximoLunes', () => {
    it('siempre cae lunes', () => {
      expect(
        diasQueFallan(() => {
          const lunes = proximoLunes();
          const dia = diaDeLaSemana(lunes);

          return dia === LUNES ? null : `${lunes} cae con día ${dia}`;
        }),
      ).toEqual([]);
    });

    /**
     * Ocho días es el piso que necesitan los tests de cancelación: la política
     * por defecto es de 24 h y hay tests que acercan el turno a una hora de
     * ahora, así que el margen tiene que sobrar de los dos lados.
     *
     * El techo de 21 no es cosmético: sin él, un `proximoLunes()` que se fuera
     * de mes en mes seguiría cumpliendo el piso y nadie se enteraría.
     */
    it('queda entre ocho y veintiún días adelante', () => {
      expect(
        diasQueFallan((hoy) => {
          const distancia = distanciaEnDias(hoy, proximoLunes());

          return distancia >= 8 && distancia <= 21
            ? null
            : `quedó a ${distancia} días`;
        }),
      ).toEqual([]);
    });

    it('nunca cae después del 28, para que la serie mensual exista', () => {
      expect(
        diasQueFallan(() => {
          const dia = diaDelMes(proximoLunes());

          return dia <= 28 ? null : `cayó el ${dia}`;
        }),
      ).toEqual([]);
    });

    it('la serie mensual repite el día del mes los tres meses', () => {
      expect(
        diasQueFallan(() => {
          const lunes = proximoLunes();
          const dias = [0, 1, 2].map((n) => diaDelMes(masMeses(lunes, n)));

          return dias.every((dia) => dia === dias[0])
            ? null
            : `${lunes} da los días ${dias.join(', ')}`;
        }),
      ).toEqual([]);
    });
  });

  describe('masDias', () => {
    it('cruza el fin de mes', () => {
      expect(masDias('2026-01-30', 3)).toBe('2026-02-02');
    });

    it('cruza el fin de año', () => {
      expect(masDias('2026-12-30', 3)).toBe('2027-01-02');
    });

    it('cae en febrero de un año bisiesto', () => {
      expect(masDias('2028-02-28', 1)).toBe('2028-02-29');
    });
  });

  describe('masMeses', () => {
    it('mantiene el día del mes', () => {
      expect(masMeses('2026-09-21', 2)).toBe('2026-11-21');
    });

    it('cruza el fin de año', () => {
      expect(masMeses('2026-11-15', 3)).toBe('2027-02-15');
    });
  });

  describe('enHorarioDe', () => {
    it('suma las tres horas de Buenos Aires', () => {
      expect(enHorarioDe('2026-09-21', '10:00')).toBe(
        '2026-09-21T13:00:00.000Z',
      );
    });

    /**
     * El caso que antes obligaba a escribir el instante UTC a mano: armando el
     * string, `23 + 3` da `"26:00"`, que no es una hora.
     */
    it('las 23:00 de Buenos Aires ya son del día siguiente en UTC', () => {
      expect(enHorarioDe('2026-09-30', '23:00')).toBe(
        '2026-10-01T02:00:00.000Z',
      );
    });

    it('la medianoche de Buenos Aires son las 03:00 UTC del mismo día', () => {
      expect(enHorarioDe('2026-10-01', '00:00')).toBe(
        '2026-10-01T03:00:00.000Z',
      );
    });
  });

  describe('bordes del mes', () => {
    it.each([
      ['2026-09-21', '2026-09-01', '2026-09-30'],
      ['2026-02-10', '2026-02-01', '2026-02-28'],
      ['2028-02-10', '2028-02-01', '2028-02-29'],
      ['2026-12-31', '2026-12-01', '2026-12-31'],
    ])('%s va del %s al %s', (fecha, primero, ultimo) => {
      expect(primerDiaDelMes(fecha)).toBe(primero);
      expect(ultimoDiaDelMes(fecha)).toBe(ultimo);
    });
  });

  describe('aDiasDeHoy', () => {
    it('cuenta en días del calendario de Buenos Aires', () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

      // 01:00 UTC del 8 todavía son las 22:00 del 7 en Buenos Aires.
      jest.setSystemTime(Date.UTC(2026, 8, 8, 1, 0));

      expect(aDiasDeHoy(0)).toBe('2026-09-07');
      expect(aDiasDeHoy(10)).toBe('2026-09-17');
    });
  });
});
