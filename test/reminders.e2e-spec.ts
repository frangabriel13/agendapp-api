import { randomUUID } from 'node:crypto';
import { AppointmentStatus, ReminderKind } from '@prisma/client';
import request from 'supertest';
import { AppointmentRemindersService } from '../src/modules/appointments/appointment-reminders.service';
import { JobLockService } from '../src/common/jobs';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RecordingMailProvider } from './utils/recording-mail.provider';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

const MS_PER_HOUR = 60 * 60 * 1_000;

/** Más viejo que `MIN_AGE_HOURS`: si no, el job lo saltea por recién creado. */
const CREATED_LONG_AGO = new Date(Date.now() - 5 * MS_PER_HOUR);

describe('Recordatorios de turno (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let mail: RecordingMailProvider;
  let tenant: RegisteredTenant;
  let reminders: AppointmentRemindersService;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;

  beforeAll(async () => {
    ({ app, prisma, mail } = await createTestApp());
    reminders = app.get(AppointmentRemindersService);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  async function createCustomer(
    email: string | null,
    phone: string,
  ): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...asOwner())
      .send({
        firstName: 'María',
        phone,
        ...(email === null ? {} : { email }),
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /**
   * Los turnos se crean por Prisma: lo que se prueba es el barrido, no el alta,
   * y por la API no se puede poner un `createdAt` de hace cinco horas.
   */
  async function createAppointment(
    hoursFromNow: number,
    options: {
      email?: string | null;
      status?: AppointmentStatus;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const startsAt = new Date(Date.now() + hoursFromNow * MS_PER_HOUR);

    const appointment = await prisma.appointment.create({
      data: {
        tenantId: tenant.tenantId,
        branchId,
        employeeId,
        customerId: await createCustomer(
          options.email === undefined ? 'maria@cliente.test' : options.email,
          `11 ${Math.floor(1000 + Math.random() * 8999)}-${Math.floor(
            1000 + Math.random() * 8999,
          )}`,
        ),
        startsAt,
        endsAt: new Date(startsAt.getTime() + MS_PER_HOUR),
        status: options.status ?? AppointmentStatus.CONFIRMED,
        // Un CHECK de la base exige la fecha cuando el estado es cancelado.
        ...(options.status === AppointmentStatus.CANCELED_BY_CUSTOMER
          ? { canceledAt: new Date() }
          : {}),
        totalPriceCents: 100_000,
        createdAt: options.createdAt ?? CREATED_LONG_AGO,
        services: {
          create: {
            tenantId: tenant.tenantId,
            serviceId,
            durationMinutes: 60,
            priceCents: 100_000,
          },
        },
      },
      select: { id: true },
    });

    return appointment.id;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');

    const branch = await request(server())
      .post('/branches')
      .set(...asOwner())
      .send({ name: 'Sucursal Centro', phone: '11 4444-5555' })
      .expect(201);

    branchId = (branch.body as { id: string }).id;

    const service = await request(server())
      .post('/services')
      .set(...asOwner())
      .send({ name: 'Corte', durationMinutes: 60, priceCents: 100_000 })
      .expect(201);

    serviceId = (service.body as { id: string }).id;

    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    employeeId = (invitation.body as { employee: { id: string } }).employee.id;

    // El armado manda mails (verificación de email, invitación del empleado).
    // Se vacía acá para que `mail.sent` cuente solo lo del job.
    mail.clear();
  });

  // ── Las dos ventanas ──────────────────────────────────────────────────────

  it('el de la víspera sale para un turno de dentro de 12 horas', async () => {
    const id = await createAppointment(12);

    expect(await reminders.sendDue()).toBe(1);

    const rows = await prisma.appointmentReminder.findMany({
      where: { appointmentId: id },
      select: { kind: true, sentTo: true },
    });

    expect(rows).toEqual([
      { kind: ReminderKind.DAY_BEFORE, sentTo: 'maria@cliente.test' },
    ]);

    const sent = mail.lastTo('maria@cliente.test');
    expect(sent.subject).toContain('recordamos');
    expect(sent.text).toContain('Sucursal Centro');
  });

  it('el de un rato antes sale para uno de dentro de una hora', async () => {
    await createAppointment(1);

    expect(await reminders.sendDue()).toBe(1);

    const rows = await prisma.appointmentReminder.findMany({
      select: { kind: true },
    });

    expect(rows).toEqual([{ kind: ReminderKind.HOURS_BEFORE }]);
    expect(mail.lastTo('maria@cliente.test').subject).toContain('en un rato');
  });

  /**
   * ⚠️ Las ventanas no se pisan, y esto es lo que lo fija. Si el de la víspera
   * fuera "las próximas 24 horas" a secas, este turno entraría en las dos y la
   * clienta recibiría dos mails seguidos diciendo lo mismo.
   */
  it('un turno cercano recibe UN solo aviso, no los dos', async () => {
    await createAppointment(1);

    expect(await reminders.sendDue()).toBe(1);
    expect(mail.to('maria@cliente.test')).toHaveLength(1);
  });

  it('un turno de pasado mañana todavía no recibe nada', async () => {
    await createAppointment(48);

    expect(await reminders.sendDue()).toBe(0);
    expect(await prisma.appointmentReminder.count()).toBe(0);
  });

  it('un turno que ya pasó no recibe nada', async () => {
    await createAppointment(-3);

    expect(await reminders.sendDue()).toBe(0);
  });

  // ── A quién no ────────────────────────────────────────────────────────────

  /** Un `PENDING_PAYMENT` se libera solo: prometerle el horario sería mentir. */
  it('un turno esperando la seña no se recuerda', async () => {
    await createAppointment(12, {
      status: AppointmentStatus.PENDING_PAYMENT,
    });

    expect(await reminders.sendDue()).toBe(0);
    expect(await prisma.appointmentReminder.count()).toBe(0);
  });

  it('un turno cancelado no se recuerda', async () => {
    await createAppointment(12, {
      status: AppointmentStatus.CANCELED_BY_CUSTOMER,
    });

    expect(await reminders.sendDue()).toBe(0);
  });

  /** Recordar algo exige que haya habido tiempo de olvidarlo. */
  it('un turno recién agendado no se recuerda todavía', async () => {
    await createAppointment(12, { createdAt: new Date() });

    expect(await reminders.sendDue()).toBe(0);
    expect(await prisma.appointmentReminder.count()).toBe(0);
  });

  /**
   * Que no haya a dónde mandarlo **no es un error**: se marca igual, o el job
   * lo reintentaría cada cuarto de hora para siempre.
   */
  it('sin casilla se marca resuelto igual, sin mandar nada', async () => {
    const id = await createAppointment(12, { email: null });

    expect(await reminders.sendDue()).toBe(0);

    const rows = await prisma.appointmentReminder.findMany({
      where: { appointmentId: id },
      select: { sentTo: true },
    });

    expect(rows).toEqual([{ sentTo: null }]);
    expect(mail.sent).toHaveLength(0);
  });

  // ── Idempotencia ──────────────────────────────────────────────────────────

  /**
   * El UNIQUE `(turno, tipo)` es el mecanismo, no un índice de consulta: es lo
   * que impide que tres réplicas manden tres mails.
   */
  it('correrlo dos veces no manda el mail dos veces', async () => {
    await createAppointment(12);

    expect(await reminders.sendDue()).toBe(1);
    expect(await reminders.sendDue()).toBe(0);
    expect(mail.to('maria@cliente.test')).toHaveLength(1);
  });

  it('dos corridas en paralelo mandan un solo mail', async () => {
    await createAppointment(12);

    const [a, b] = await Promise.all([
      reminders.sendDue(),
      reminders.sendDue(),
    ]);

    expect(a + b).toBe(1);
    expect(await prisma.appointmentReminder.count()).toBe(1);
    expect(mail.to('maria@cliente.test')).toHaveLength(1);
  });

  /** Un proveedor de mail caído no puede dejar el aviso en un limbo eterno. */
  it('si el mail falla el aviso queda igual marcado', async () => {
    await createAppointment(12);
    mail.failing(true);

    expect(await reminders.sendDue()).toBe(0);
    expect(await prisma.appointmentReminder.count()).toBe(1);
  });

  // ── Aislamiento ───────────────────────────────────────────────────────────

  it('cada aviso queda con el negocio de su turno', async () => {
    await createAppointment(12);
    await reminders.sendDue();

    const rows = await prisma.appointmentReminder.findMany({
      select: { tenantId: true },
    });

    expect(rows).toEqual([{ tenantId: tenant.tenantId }]);
  });

  // ── El lock entre réplicas (§8.4) ─────────────────────────────────────────

  describe('lock de jobs', () => {
    const jobLock = () => app.get(JobLockService);

    it('el primero entra', async () => {
      expect(
        await jobLock().run('un-job', () => Promise.resolve('listo')),
      ).toBe('listo');
    });

    /**
     * ⚠️ La prueba de que el advisory lock **de verdad excluye** contra
     * Postgres, y no solo compila. Si `pg_try_advisory_xact_lock` no tomara el
     * lock —un cast mal puesto, por ejemplo— los dos entrarían y este test
     * seguiría en verde con `corriendo` en 2.
     */
    it('mientras uno corre, el otro se saltea el tick', async () => {
      let corriendo = 0;
      let segundo: string | null = 'todavía no';

      await jobLock().run('mismo-job', async () => {
        corriendo += 1;

        segundo = await jobLock().run('mismo-job', () => {
          corriendo += 1;

          return Promise.resolve('entré');
        });
      });

      expect(corriendo).toBe(1);
      expect(segundo).toBeNull();
    });

    it('dos jobs distintos no se estorban', async () => {
      const resultado = await jobLock().run('job-a', () =>
        jobLock().run('job-b', () => Promise.resolve('entré')),
      );

      expect(resultado).toBe('entré');
    });

    /** El lock se suelta al terminar la transacción, incluso si el job falla. */
    it('un job que revienta no deja el lock tomado', async () => {
      await expect(
        jobLock().run('job-que-falla', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(
        await jobLock().run('job-que-falla', () => Promise.resolve('ok')),
      ).toBe('ok');
    });
  });
});
