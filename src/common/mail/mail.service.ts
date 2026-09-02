import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAIL_PROVIDER, type MailProvider } from './mail.types';
import {
  appointmentReminderMail,
  bookingConfirmationMail,
  bookingNoticeMail,
  type BookingMailAppointment,
} from './templates/booking';
import { type MailContent, renderHtml, renderText } from './templates/layout';
import {
  emailVerificationMail,
  employeeInvitationMail,
  passwordResetMail,
} from './templates/transactional';

/**
 * La cara visible del correo: los flujos de negocio piden "mandá el reset", no
 * arman HTML ni saben qué proveedor hay atrás.
 *
 * **Un mail que falla nunca voltea el request.** Es la decisión de diseño
 * importante de este archivo: si Resend está caído, un registro tiene que
 * seguir creando el negocio y un reset tiene que seguir emitiendo el token. El
 * error va al log y el método devuelve `false`; el que llamó decide si eso le
 * importa. Al revés —dejar burbujear— convierte una caída del proveedor de mail
 * en una caída del alta de usuarios, que es muchísimo peor que un mail perdido.
 *
 * El envío es **sincrónico dentro del request**: se espera al proveedor. Con un
 * timeout de 10 segundos alcanza por ahora; sacarlo del camino crítico y darle
 * reintentos es trabajo de la cola (BullMQ, Fase 8), y cuando exista lo único
 * que cambia es el cuerpo de `deliver`.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(@Inject(MAIL_PROVIDER) private readonly provider: MailProvider) {}

  /** Link para elegir una contraseña nueva. */
  sendPasswordReset(params: {
    to: string;
    firstName: string;
    url: string;
    expiresAt: Date;
  }): Promise<boolean> {
    return this.deliver(params.to, passwordResetMail(params));
  }

  /** Link para confirmar que la casilla existe y es de quien dice. */
  sendEmailVerification(params: {
    to: string;
    firstName: string;
    url: string;
    expiresAt: Date;
  }): Promise<boolean> {
    return this.deliver(params.to, emailVerificationMail(params));
  }

  /** Link de activación de un empleado recién invitado. */
  sendEmployeeInvitation(params: {
    to: string;
    firstName: string;
    businessName: string;
    url: string;
    expiresAt: Date;
  }): Promise<boolean> {
    return this.deliver(params.to, employeeInvitationMail(params));
  }

  /**
   * A quien reservó desde el portal público: qué reservó y, si falta seña, el
   * link para pagarla.
   */
  sendBookingConfirmation(params: {
    to: string;
    firstName: string;
    appointment: BookingMailAppointment;
    deposit?: { amountCents: number; currency: string; url: string };
    businessPhone: string | null;
  }): Promise<boolean> {
    return this.deliver(params.to, bookingConfirmationMail(params));
  }

  /** Al negocio: entró una reserva por la web, y con qué teléfono ubicarla. */
  sendBookingNotice(params: {
    to: string;
    appointment: BookingMailAppointment;
    customerName: string;
    customerPhone: string;
    awaitingDeposit: boolean;
  }): Promise<boolean> {
    return this.deliver(params.to, bookingNoticeMail(params));
  }

  /** El aviso previo al turno: el de la víspera y el de un rato antes. */
  sendAppointmentReminder(params: {
    to: string;
    firstName: string;
    appointment: BookingMailAppointment;
    imminent: boolean;
    cancellationPolicyHours: number;
    businessPhone: string | null;
  }): Promise<boolean> {
    return this.deliver(params.to, appointmentReminderMail(params));
  }

  /**
   * Renderiza y entrega. Devuelve si salió, sin lanzar nunca.
   *
   * El log del fallo NO incluye el cuerpo del mail: ahí viaja el link con el
   * token, y un token en los logs es un token comprometido.
   */
  private async deliver(to: string, content: MailContent): Promise<boolean> {
    try {
      await this.provider.send({
        to,
        subject: content.subject,
        html: renderHtml(content),
        text: renderText(content),
      });

      return true;
    } catch (error) {
      this.logger.error(
        {
          to,
          subject: content.subject,
          provider: this.provider.name,
          err: error instanceof Error ? error.message : String(error),
        },
        'No se pudo enviar el mail',
      );

      return false;
    }
  }
}
