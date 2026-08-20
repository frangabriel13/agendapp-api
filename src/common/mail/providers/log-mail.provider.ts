import { Injectable, Logger } from '@nestjs/common';
import type { MailMessage, MailProvider } from '../mail.types';

/** Saca los links del cuerpo en texto plano. */
const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * El proveedor por defecto: no manda nada, lo escribe en el log.
 *
 * No es un stub de descarte, es el modo de desarrollo. Loguea los links del
 * mail justamente para que se puedan copiar de la consola: sin esto, probar un
 * reset de contraseña en local exigiría una casilla de verdad y un dominio
 * configurado. Que sea el default es a propósito — arrancar el proyecto no
 * debería requerir credenciales de nadie.
 *
 * En producción `MAIL_PROVIDER=resend`. Si alguien despliega sin configurarlo,
 * los mails no salen pero quedan en el log, que es bastante mejor que fallar.
 */
@Injectable()
export class LogMailProvider implements MailProvider {
  readonly name = 'log';

  private readonly logger = new Logger(LogMailProvider.name);

  send(message: MailMessage): Promise<void> {
    this.logger.log(
      {
        to: message.to,
        subject: message.subject,
        links: message.text.match(URL_PATTERN) ?? [],
      },
      'Mail NO enviado (MAIL_PROVIDER=log): copiá el link de acá',
    );

    return Promise.resolve();
  }
}
