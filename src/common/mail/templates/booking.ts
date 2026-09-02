import type { MailContent } from './layout';

/**
 * Los dos mails de una reserva hecha desde el portal público: uno a quien
 * reservó y otro al negocio.
 *
 * **Son dos y no uno con dos destinatarios** porque dicen cosas distintas. A la
 * clienta le importa cuándo tiene que venir y —si falta— cómo pagar la seña; al
 * negocio le importa quién es y cómo ubicarla. Mandar el mismo texto a los dos
 * significaría o darle el teléfono de la clienta a ella misma, o no dárselo al
 * negocio, que es el dato por el que abre el mail.
 *
 * Como el resto de las plantillas, funciones puras: se testean sin levantar
 * nada ni mandar nada.
 */

/** El único idioma que hablan hoy los mails; el negocio elige zona, no locale. */
const LOCALE = 'es-AR';

const CENTS_PER_UNIT = 100;

/**
 * `"lunes 8 de septiembre, 14:30"`, **en la zona del negocio**.
 *
 * La zona no es opcional ni tiene default: el turno se guarda como instante y
 * formatearlo con la del servidor le diría a una clienta de Buenos Aires que
 * viene tres horas antes. Es el mismo cuidado que el resto del sistema tiene
 * con la hora de pared, solo que acá el error se ve recién cuando alguien no
 * aparece.
 */
export function formatWhen(instant: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(instant);

  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);

  return `${date}, ${time}`;
}

/** Centavos a plata legible. `12500` + `ARS` → `"$ 12.500,00"`. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
  }).format(cents / CENTS_PER_UNIT);
}

export interface BookingMailAppointment {
  businessName: string;
  /** Cuándo empieza. Se formatea con `timezone`, nunca con la del servidor. */
  startsAt: Date;
  timezone: string;
  serviceNames: string[];
  employeeName: string;
  branchName: string;
  branchAddress: string | null;
}

/**
 * Confirmación a quien reservó.
 *
 * **El mail cambia entero según haya seña pendiente o no**, y esa es toda su
 * complejidad. Con seña el turno todavía no está: el asunto lo dice, el cuerpo
 * lo dice y el botón lleva a pagar. Sin seña, está confirmado y no hay botón.
 * Un texto único que dijera "tu turno está reservado" y abajo "pagá la seña"
 * deja a la mitad de la gente creyendo que ya tiene el turno.
 */
export function bookingConfirmationMail(params: {
  firstName: string;
  appointment: BookingMailAppointment;
  deposit?: { amountCents: number; currency: string; url: string };
  businessPhone: string | null;
}): MailContent {
  const { appointment: appt, deposit } = params;
  const when = formatWhen(appt.startsAt, appt.timezone);
  const services = appt.serviceNames.join(', ');
  const where =
    appt.branchAddress === null
      ? appt.branchName
      : `${appt.branchName} (${appt.branchAddress})`;

  const detail = [
    `${services} con ${appt.employeeName}.`,
    `${when}, en ${where}.`,
  ];

  const footer = [
    params.businessPhone === null
      ? `Si no vas a poder venir, avisale a ${appt.businessName}.`
      : `Si no vas a poder venir, avisale a ${appt.businessName} al ${params.businessPhone}.`,
  ];

  if (!deposit) {
    return {
      subject: `Tu turno en ${appt.businessName} quedó confirmado`,
      preview: `${when}. Te esperamos.`,
      heading: 'Tu turno quedó confirmado',
      paragraphs: [`Hola ${params.firstName}: reservaste un turno.`, ...detail],
      footer,
    };
  }

  const amount = formatMoney(deposit.amountCents, deposit.currency);

  return {
    subject: `Falta pagar la seña de tu turno en ${appt.businessName}`,
    preview: `${when}. El turno se confirma cuando entre la seña.`,
    heading: 'Tu turno está reservado, falta la seña',
    paragraphs: [
      `Hola ${params.firstName}: te guardamos el horario.`,
      ...detail,
      `Para confirmarlo hay que pagar una seña de ${amount}. Hasta que entre, el turno no está tomado.`,
    ],
    action: { label: `Pagar la seña de ${amount}`, url: deposit.url },
    footer,
  };
}

/**
 * Aviso al negocio de que entró una reserva.
 *
 * Trae el teléfono porque **es lo que se hace con este mail**: si algo no
 * cierra, alguien levanta el tubo. Va a la casilla del negocio, no a la de la
 * clienta.
 */
export function bookingNoticeMail(params: {
  appointment: BookingMailAppointment;
  customerName: string;
  customerPhone: string;
  awaitingDeposit: boolean;
}): MailContent {
  const { appointment: appt } = params;
  const when = formatWhen(appt.startsAt, appt.timezone);
  const services = appt.serviceNames.join(', ');

  return {
    subject: `Nueva reserva web: ${params.customerName}, ${when}`,
    preview: `${services} con ${appt.employeeName}.`,
    heading: 'Entró una reserva desde tu web',
    paragraphs: [
      `${params.customerName} (${params.customerPhone}) reservó ${services} con ${appt.employeeName}.`,
      `${when}, en ${appt.branchName}.`,
      params.awaitingDeposit
        ? 'Todavía no pagó la seña: el turno queda tomado un rato y se libera solo si no paga.'
        : 'El turno ya está confirmado.',
    ],
    footer: ['La reserva ya está en tu agenda. No hace falta que hagas nada.'],
  };
}
