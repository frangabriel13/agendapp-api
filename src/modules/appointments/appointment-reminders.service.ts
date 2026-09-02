import { Injectable, Logger } from '@nestjs/common';
import { AppointmentStatus, Prisma, ReminderKind } from '@prisma/client';
import { JobLockService } from '../../common/jobs';
import { MailService } from '../../common/mail';
import type { BookingMailAppointment } from '../../common/mail/templates/booking';
import { PrismaService } from '../../prisma/prisma.service';

const MS_PER_HOUR = 60 * 60 * 1_000;

/**
 * Las dos ventanas, en horas desde ahora, medio abiertas: `(from, to]`.
 *
 * **No se pisan, y eso es lo que hace que cada turno reciba cada aviso una sola
 * vez.** Si el de la víspera fuera "los próximos 24 horas" a secas, un turno de
 * dentro de una hora entraría en los dos y la clienta recibiría dos mails
 * seguidos diciendo lo mismo.
 *
 * Van de más cerca a más lejos porque así se leen: primero el inminente.
 */
const WINDOWS = [
  { kind: ReminderKind.HOURS_BEFORE, fromHours: 0, toHours: 2 },
  { kind: ReminderKind.DAY_BEFORE, fromHours: 2, toHours: 24 },
] as const;

/**
 * Cuánto tiene que haber pasado desde que se agendó para que un aviso sea un
 * *recordatorio*.
 *
 * Sin esto, alguien que reserva para esta tarde recibe la confirmación y, al
 * tick siguiente, un mail recordándole lo que acaba de hacer. Recordar algo
 * exige que haya habido tiempo de olvidarlo.
 */
const MIN_AGE_HOURS = 1;

/**
 * Tope de avisos por corrida.
 *
 * El cron pasa cada 15 minutos, así que lo que no entra en una corrida sale en
 * la siguiente. Existe para que un backlog inesperado —la primera corrida
 * después de un despliegue, o después de un rato caído— no se traduzca en
 * cientos de llamadas seguidas al proveedor de mail.
 */
const MAX_PER_RUN = 200;

const CANDIDATE_SELECT = {
  id: true,
  startsAt: true,
  customer: { select: { firstName: true, email: true } },
  branch: { select: { name: true, address: true, phone: true } },
  employee: {
    select: { user: { select: { firstName: true, lastName: true } } },
  },
  services: { select: { service: { select: { name: true } } } },
  tenant: {
    select: {
      id: true,
      businessName: true,
      timezone: true,
      settings: { select: { cancellationPolicyHours: true } },
    },
  },
} satisfies Prisma.AppointmentSelect;

type Candidate = Prisma.AppointmentGetPayload<{
  select: typeof CANDIDATE_SELECT;
}>;

/** Un aviso ya reservado en la base, listo para mandarse. */
interface ClaimedReminder {
  appointmentId: string;
  kind: ReminderKind;
  to: string;
  firstName: string;
  imminent: boolean;
  cancellationPolicyHours: number;
  businessPhone: string | null;
  mail: BookingMailAppointment;
}

/**
 * Los avisos previos al turno.
 *
 * El orden de las dos mitades es la decisión importante:
 *
 * 1. **Primero se reserva el aviso en la base, después se manda el mail.** La
 *    fila de `AppointmentReminder` con su UNIQUE `(turno, tipo)` es lo que
 *    impide el duplicado: con tres réplicas barriendo a la vez, el INSERT lo
 *    gana una sola y las otras chocan y siguen. Al revés —mandar y después
 *    anotar— dos instancias mandarían los dos mails antes de que ninguna
 *    anotara nada.
 * 2. **El mail sale afuera del lock del job.** Sostener una transacción de
 *    Postgres mientras se espera a un proveedor HTTP es exactamente lo que no
 *    hay que hacer, y `JobLockService` sostiene el lock durante todo el
 *    callback.
 *
 * La consecuencia aceptada: si el proceso se muere entre la reserva y el envío,
 * esos avisos se pierden en silencio. Es el lado correcto para fallar — un
 * recordatorio perdido es una molestia, un recordatorio duplicado es un mail
 * que la clienta lee como spam.
 *
 * **La fila significa "resuelto", no "entregado".** Quien no dejó mail se
 * marca igual, con `sentTo` en `null`: no tener a dónde mandarlo no es un
 * error, y sin la marca el job lo reintentaría cada cuarto de hora para
 * siempre.
 */
@Injectable()
export class AppointmentRemindersService {
  private readonly logger = new Logger(AppointmentRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly jobLock: JobLockService,
  ) {}

  /**
   * Reserva los avisos que corresponden y los manda.
   *
   * Devuelve cuántos mails salieron, que no es lo mismo que cuántos avisos se
   * resolvieron: los turnos sin casilla cuentan como resueltos y no como
   * enviados.
   */
  async sendDue(now = new Date()): Promise<number> {
    const claimed = await this.jobLock.run('appointment-reminders', () =>
      this.claim(now),
    );

    if (claimed === null) {
      return 0;
    }

    let sent = 0;

    for (const reminder of claimed) {
      const delivered = await this.mail.sendAppointmentReminder({
        to: reminder.to,
        firstName: reminder.firstName,
        appointment: reminder.mail,
        imminent: reminder.imminent,
        cancellationPolicyHours: reminder.cancellationPolicyHours,
        businessPhone: reminder.businessPhone,
      });

      if (delivered) {
        sent += 1;
      }
    }

    return sent;
  }

  /**
   * Escribe las filas de los avisos que tocan y devuelve los que tienen a
   * dónde ir.
   *
   * Corre con el lock tomado, así que hace lo mínimo: consultas y nada de red.
   */
  private async claim(now: Date): Promise<ClaimedReminder[]> {
    const claimed: ClaimedReminder[] = [];

    for (const window of WINDOWS) {
      const candidates = await this.candidatesFor(window, now);

      for (const appointment of candidates) {
        if (claimed.length >= MAX_PER_RUN) {
          return claimed;
        }

        const to = appointment.customer.email;
        const reserved = await this.reserve(appointment, window.kind, to);

        if (!reserved || to === null) {
          continue;
        }

        claimed.push(this.toReminder(appointment, window.kind, to));
      }
    }

    return claimed;
  }

  private candidatesFor(
    window: (typeof WINDOWS)[number],
    now: Date,
  ): Promise<Candidate[]> {
    return this.prisma.appointment.findMany({
      where: {
        // Solo los confirmados. Un `PENDING_PAYMENT` todavía no es un turno
        // —se libera solo si nadie paga— y recordarlo sería prometer un
        // horario que el propio sistema puede sacar.
        status: AppointmentStatus.CONFIRMED,
        deletedAt: null,
        tenant: { deletedAt: null },
        startsAt: {
          gt: new Date(now.getTime() + window.fromHours * MS_PER_HOUR),
          lte: new Date(now.getTime() + window.toHours * MS_PER_HOUR),
        },
        createdAt: {
          lt: new Date(now.getTime() - MIN_AGE_HOURS * MS_PER_HOUR),
        },
        // El descarte grueso: los que ya tienen el aviso no se traen. El UNIQUE
        // sigue siendo quien lo garantiza —entre esta consulta y el INSERT
        // puede entrar otra instancia— pero sin este filtro cada corrida
        // levantaría la agenda entera para descartarla de a una.
        reminders: { none: { kind: window.kind } },
      },
      select: CANDIDATE_SELECT,
      orderBy: { startsAt: 'asc' },
      take: MAX_PER_RUN,
    });
  }

  /**
   * Reserva el aviso. `false` si otra instancia llegó primero.
   *
   * El `catch` del unique **no es un caso de error**: es el mecanismo
   * funcionando. Cualquier otra falla sí se loguea y se saltea ese turno, para
   * que un dato roto en una fila no deje sin recordatorio al resto de la
   * agenda.
   */
  private async reserve(
    appointment: Candidate,
    kind: ReminderKind,
    to: string | null,
  ): Promise<boolean> {
    try {
      await this.prisma.appointmentReminder.create({
        data: {
          tenantId: appointment.tenant.id,
          appointmentId: appointment.id,
          kind,
          sentTo: to,
        },
        select: { id: true },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }

      this.logger.error(
        {
          appointmentId: appointment.id,
          kind,
          err: error instanceof Error ? error.message : String(error),
        },
        'No se pudo reservar el recordatorio',
      );

      return false;
    }
  }

  private toReminder(
    appointment: Candidate,
    kind: ReminderKind,
    to: string,
  ): ClaimedReminder {
    const employee = appointment.employee.user;

    return {
      appointmentId: appointment.id,
      kind,
      to,
      firstName: appointment.customer.firstName,
      imminent: kind === ReminderKind.HOURS_BEFORE,
      cancellationPolicyHours:
        appointment.tenant.settings?.cancellationPolicyHours ?? 0,
      businessPhone: appointment.branch.phone,
      mail: {
        businessName: appointment.tenant.businessName,
        startsAt: appointment.startsAt,
        timezone: appointment.tenant.timezone,
        serviceNames: appointment.services.map((row) => row.service.name),
        employeeName: `${employee.firstName} ${employee.lastName}`,
        branchName: appointment.branch.name,
        branchAddress: appointment.branch.address,
      },
    };
  }
}
