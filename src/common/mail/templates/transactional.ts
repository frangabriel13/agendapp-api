import type { MailContent } from './layout';

/**
 * Los tres mails que manda el sistema hoy. Cada uno es una función pura que
 * devuelve un `MailContent`: se pueden testear sin levantar nada ni mandar nada.
 *
 * El tono es el mismo en los tres: qué pasó, qué tenés que hacer, y qué hacer
 * si no fuiste vos. Nada de "estimado usuario".
 */

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * "en 1 hora", "en 3 días". Redondea hacia arriba a propósito: decirle a alguien
 * que tiene menos tiempo del que tiene es preferible a lo contrario.
 */
export function humanizeExpiry(expiresAt: Date, now = new Date()): string {
  const hours = Math.max(
    1,
    Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_HOUR),
  );

  if (hours < 24) {
    return hours === 1 ? 'en 1 hora' : `en ${hours} horas`;
  }

  const days = Math.round(hours / 24);

  return days === 1 ? 'en 1 día' : `en ${days} días`;
}

export function passwordResetMail(params: {
  firstName: string;
  url: string;
  expiresAt: Date;
}): MailContent {
  return {
    subject: 'Restablecé tu contraseña',
    preview: `El link vence ${humanizeExpiry(params.expiresAt)}.`,
    heading: 'Restablecé tu contraseña',
    paragraphs: [
      `Hola ${params.firstName}: pediste volver a entrar a tu cuenta.`,
      `El link vence ${humanizeExpiry(params.expiresAt)} y sirve una sola vez.`,
    ],
    action: { label: 'Elegir una contraseña nueva', url: params.url },
    footer: [
      'Si no pediste esto, ignorá el mail: tu contraseña actual sigue funcionando y nadie entró a tu cuenta.',
    ],
  };
}

export function emailVerificationMail(params: {
  firstName: string;
  url: string;
  expiresAt: Date;
}): MailContent {
  return {
    subject: 'Confirmá tu email',
    preview: 'Un clic y terminamos de configurar tu cuenta.',
    heading: 'Confirmá tu email',
    paragraphs: [
      `Hola ${params.firstName}: confirmanos que esta casilla es tuya.`,
      `Sirve para poder avisarte cosas importantes de tu cuenta y para que puedas recuperarla si alguna vez perdés la contraseña. El link vence ${humanizeExpiry(params.expiresAt)}.`,
    ],
    action: { label: 'Confirmar mi email', url: params.url },
    footer: [
      'Si no creaste una cuenta en AgendApp, alguien se equivocó al escribir su dirección. Ignorá el mail.',
    ],
  };
}

export function employeeInvitationMail(params: {
  firstName: string;
  businessName: string;
  url: string;
  expiresAt: Date;
}): MailContent {
  return {
    subject: `${params.businessName} te invitó a su equipo`,
    preview: `Elegí una contraseña y entrá a la agenda de ${params.businessName}.`,
    heading: `Te sumaron al equipo de ${params.businessName}`,
    paragraphs: [
      `Hola ${params.firstName}: te crearon una cuenta en AgendApp para que puedas ver y manejar la agenda de ${params.businessName}.`,
      `Para activarla solo tenés que elegir una contraseña. El link vence ${humanizeExpiry(params.expiresAt)}.`,
    ],
    action: { label: 'Activar mi cuenta', url: params.url },
    footer: [
      'Si no esperabas esta invitación, ignorá el mail: sin elegir una contraseña la cuenta no se puede usar.',
    ],
  };
}
