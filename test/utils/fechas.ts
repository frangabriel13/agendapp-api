/**
 * Las fechas de los tests e2e, calculadas y no escritas a mano.
 *
 * Esto existe por un bug real. Los specs tenían `const LUNES = '2026-09-07'`,
 * elegido cuando esa fecha era futura. El 7 de septiembre de 2026 el reloj la
 * alcanzó: el turno de las 10:00 quedó primero a menos de 24 h y después en el
 * pasado, o sea **fuera de la política de cancelación**, y dos tests que nadie
 * había tocado empezaron a fallar solos. El síntoma es de los peores que hay,
 * porque el commit que rompe la suite no es el que la rompió.
 *
 * La regla que queda: una fecha de test no se escribe a mano nunca. Se calcula
 * contra el reloj y todas las demás se derivan de esa.
 */

/** Buenos Aires es UTC-3 todo el año: no hay horario de verano que corregir. */
export const BA_OFFSET_HOURS = 3;

/** El día de hoy en Buenos Aires, a medianoche UTC, como fecha manipulable. */
function hoyEnBuenosAires(): Date {
  const corrido = new Date(Date.now() - BA_OFFSET_HOURS * 60 * 60 * 1_000);

  return new Date(
    Date.UTC(
      corrido.getUTCFullYear(),
      corrido.getUTCMonth(),
      corrido.getUTCDate(),
    ),
  );
}

const soloFecha = (fecha: Date): string => fecha.toISOString().slice(0, 10);

/**
 * El próximo lunes cómodamente futuro, como `YYYY-MM-DD`.
 *
 * **Lunes** porque los specs configuran el horario del negocio ese día y las
 * series repetidas cuentan lunes.
 *
 * **Cómodamente** son al menos ocho días. La política de cancelación por
 * defecto es de 24 h y hay tests que acercan el turno a una hora de ahora para
 * dejarlo fuera de término: el margen tiene que sobrar de los dos lados, no
 * alcanzar justo.
 *
 * **Y con día del mes ≤ 28**, porque la serie MENSUAL repite el día del mes:
 * arrancando un lunes 31 el mes siguiente no tendría dónde caer, y el test
 * fallaría uno de cada tantos meses, que es peor que fallar siempre.
 */
export function proximoLunes(): string {
  const cursor = hoyEnBuenosAires();

  cursor.setUTCDate(cursor.getUTCDate() + 8);

  while (cursor.getUTCDay() !== 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Sumar una semana desde un 29, 30 o 31 cae en el 1 al 4 del mes siguiente,
  // que sigue siendo lunes. Por eso alcanza con una vuelta.
  while (cursor.getUTCDate() > 28) {
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return soloFecha(cursor);
}

/** `YYYY-MM-DD` más N días. */
export function masDias(fecha: string, dias: number): string {
  const cursor = new Date(`${fecha}T00:00:00.000Z`);

  cursor.setUTCDate(cursor.getUTCDate() + dias);

  return soloFecha(cursor);
}

/**
 * `YYYY-MM-DD` más N meses, manteniendo el día del mes.
 *
 * Solo es seguro con días ≤ 28, que es lo que garantiza `proximoLunes()`: para
 * un 31 de enero, `Date` desborda a marzo en vez de recortar a febrero.
 */
export function masMeses(fecha: string, meses: number): string {
  const cursor = new Date(`${fecha}T00:00:00.000Z`);

  return soloFecha(
    new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + meses,
        cursor.getUTCDate(),
      ),
    ),
  );
}

/**
 * `"10:00"` de ese día en Buenos Aires, como instante ISO en UTC.
 *
 * La suma va por `Date` y no armando el string a mano, que es como estaba en
 * cada spec: `"23:00"` más tres horas da `"26:00"`, un ISO inválido. Por eso
 * los tests del borde del mes tenían escrito el instante UTC crudo con un
 * comentario al lado explicando la cuenta.
 */
export function enHorarioDe(fecha: string, hhmm: string): string {
  const [horas, minutos] = hhmm.split(':').map(Number);
  const instante = new Date(`${fecha}T00:00:00.000Z`);

  instante.setUTCMinutes(
    instante.getUTCMinutes() + (horas + BA_OFFSET_HOURS) * 60 + minutos,
  );

  return instante.toISOString();
}

/** El último día del mes de esa fecha, como `YYYY-MM-DD`. */
export function ultimoDiaDelMes(fecha: string): string {
  const cursor = new Date(`${fecha}T00:00:00.000Z`);

  return soloFecha(
    new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)),
  );
}

/** El primer día del mes de esa fecha, como `YYYY-MM-DD`. */
export function primerDiaDelMes(fecha: string): string {
  return `${fecha.slice(0, 7)}-01`;
}

/**
 * La fecha del día que está a N días de hoy, en Buenos Aires.
 *
 * Para los tests que miden una **distancia hasta el turno** (la política de
 * cancelación) y no les importa el día de la semana.
 */
export function aDiasDeHoy(dias: number): string {
  return masDias(soloFecha(hoyEnBuenosAires()), dias);
}
