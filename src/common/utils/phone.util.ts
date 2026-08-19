/**
 * Normalización de teléfonos para detectar clientes repetidos.
 *
 * El problema: la misma persona se carga hoy como "11 5555-1234" y mañana como
 * "+54 9 11 5555-1234". Guardadas tal cual son dos fichas distintas, y el
 * historial de la clienta queda partido al medio.
 *
 * La solución: además del teléfono como lo tipearon (que es el que se muestra y
 * el que se marca), se guarda una versión canónica en `phone_normalized`, y el
 * unique de la base va sobre esa.
 *
 * **Criterio: solo los dígitos, y de esos los últimos 10.** En Argentina un
 * número completo son 10 dígitos (área + abonado); lo que sobra adelante es
 * ruido de marcación — el `+54` del país, el `9` de celular, el `0` de larga
 * distancia. Recortar por atrás los saca a todos sin tener que parsear nada.
 *
 * Límites conocidos, asumidos a propósito:
 *
 * - El `15` viejo de los celulares (`011 15 5555-1234`) queda dentro de los
 *   últimos 10 dígitos, así que ese formato NO se reconoce como igual al
 *   internacional. Es un formato en retirada y arreglarlo a mano implicaría
 *   adivinar dónde termina el código de área, que varía entre 2 y 4 dígitos.
 * - Números de otros países más largos que 10 dígitos se comparan por su cola.
 *   Dos extranjeros que coincidan en los últimos 10 dígitos chocarían entre sí.
 *   Con clientes de barrio no pasa; el día que importe, esto se reemplaza por
 *   `libphonenumber-js` sin tocar nada más — por eso vive acá y no inline.
 *
 * El valor crudo se conserva siempre: normalizar es para comparar, no para
 * pisar lo que la persona escribió.
 */

/** Cuántos dígitos finales alcanzan para identificar un número argentino. */
const SIGNIFICANT_DIGITS = 10;

/** `"+54 9 11 5555-1234"` → `"1155551234"`. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  return digits.length > SIGNIFICANT_DIGITS
    ? digits.slice(-SIGNIFICANT_DIGITS)
    : digits;
}

/**
 * Que haya quedado algo con lo que comparar.
 *
 * `@Matches` en el DTO ya exige al menos un dígito, así que esto solo se
 * dispara si alguien llama al service por fuera de un request HTTP (un seed, un
 * import masivo). Vale igual: sin esto, dos clientes cargados con "sin
 * teléfono" chocarían contra el unique con un error incomprensible.
 */
export function hasComparablePhone(phone: string): boolean {
  return normalizePhone(phone).length > 0;
}
