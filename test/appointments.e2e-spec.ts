import { randomUUID } from 'node:crypto';
import { AppointmentStatus } from '@prisma/client';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

/** Lunes, bien adelante: así cancelar "en término" siempre da en término. */
const LUNES = '2026-09-07';
const MARTES = '2026-09-08';
const DAY_OF_WEEK = 1;

interface AppointmentResponse {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  totalPriceCents: number;
  depositAmountCents: number | null;
  notes: string | null;
  employee: { id: string; name: string };
  customer: { id: string };
  services: {
    serviceId: string;
    name: string;
    durationMinutes: number;
    priceCents: number;
  }[];
  resources: { resourceId: string; name: string }[];
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
  canceledAt: string | null;
  cancellationReason: string | null;
}

interface ChangeStatusResult {
  appointment: AppointmentResponse;
  refund: {
    type: string;
    amountCents: number;
    withinPolicy: boolean;
    reason: string;
  } | null;
}

/** `"09:00"` de Buenos Aires como instante ISO (UTC-3 todo el año). */
function enBuenosAires(hhmm: string, date = LUNES): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${date}T${String(hours + 3).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`;
}

function tokenFromUrl(activationUrl: string): string {
  const token = new URL(activationUrl).searchParams.get('token');

  if (!token) {
    throw new Error(`El link de activación no trae token: ${activationUrl}`);
  }

  return token;
}

describe('Turnos (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;
  let customerId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  async function createBranch(name = 'Sucursal Centro'): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function setBusinessHours(id: string): Promise<void> {
    await request(server())
      .put(`/branches/${id}/business-hours`)
      .set(...auth(tenant.accessToken))
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);
  }

  async function createService(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(server())
      .post('/services')
      .set(...auth(tenant.accessToken))
      .send({
        name: `Servicio ${randomUUID().slice(0, 8)}`,
        durationMinutes: 60,
        priceCents: 100_000,
        ...body,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function createProfessional(firstName = 'Lucía'): Promise<string> {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email,
        firstName,
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    const body = invitation.body as {
      employee: { id: string };
      activationUrl: string;
    };

    await request(server())
      .post('/employees/activate')
      .send({
        token: tokenFromUrl(body.activationUrl),
        password: 'claveNueva123',
      })
      .expect(204);

    await request(server())
      .put(`/employees/${body.employee.id}/schedules`)
      .set(...auth(tenant.accessToken))
      .send({
        shifts: [DAY_OF_WEEK, 2].map((dayOfWeek) => ({
          branchId,
          dayOfWeek,
          startsAt: '09:00',
          endsAt: '18:00',
        })),
      })
      .expect(200);

    return body.employee.id;
  }

  async function assign(
    service: string,
    assignments: { employeeId: string; branchId: string }[],
  ): Promise<void> {
    await request(server())
      .put(`/services/${service}/employees`)
      .set(...auth(tenant.accessToken))
      .send({ assignments })
      .expect(200);
  }

  async function createCustomer(): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...auth(tenant.accessToken))
      .send({ firstName: 'María', phone: `11 5555-${randomDigits()}` })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  const randomDigits = (): string =>
    String(Math.floor(1000 + Math.random() * 8999));

  const book = (body: Record<string, unknown> = {}): request.Test =>
    request(server())
      .post('/appointments')
      .set(...auth(tenant.accessToken))
      .send({
        branchId,
        employeeId,
        customerId,
        serviceIds: [serviceId],
        startsAt: enBuenosAires('10:00'),
        ...body,
      });

  async function bookOk(
    body: Record<string, unknown> = {},
  ): Promise<AppointmentResponse> {
    const response = await book(body).expect(201);

    return response.body as AppointmentResponse;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'empresa');

    branchId = await createBranch();
    await setBusinessHours(branchId);
    serviceId = await createService();
    employeeId = await createProfessional();
    await assign(serviceId, [{ employeeId, branchId }]);
    customerId = await createCustomer();
  });

  describe('Agendar', () => {
    it('crea el turno y calcula el fin con duración y buffer', async () => {
      serviceId = await createService({
        durationMinutes: 45,
        bufferAfterMinutes: 15,
        priceCents: 150_000,
      });
      await assign(serviceId, [{ employeeId, branchId }]);

      const turno = await bookOk();

      expect(turno).toMatchObject({
        startsAt: enBuenosAires('10:00'),
        endsAt: enBuenosAires('11:00'), // 45 + 15
        status: AppointmentStatus.CONFIRMED,
        totalPriceCents: 150_000,
      });
    });

    /**
     * El punto del snapshot: la lista de precios cambia, los turnos ya
     * agendados no.
     */
    it('congela precio y duración al reservar', async () => {
      const turno = await bookOk();

      await request(server())
        .patch(`/services/${serviceId}`)
        .set(...auth(tenant.accessToken))
        .send({ priceCents: 999_999, durationMinutes: 30 })
        .expect(200);

      const leido = await request(server())
        .get(`/appointments/${turno.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((leido.body as AppointmentResponse).services[0]).toMatchObject({
        priceCents: 100_000,
        durationMinutes: 60,
      });
      expect((leido.body as AppointmentResponse).totalPriceCents).toBe(100_000);
    });

    it('con varios servicios suma duraciones y precios', async () => {
      const segundo = await createService({
        durationMinutes: 30,
        priceCents: 50_000,
      });
      await assign(segundo, [{ employeeId, branchId }]);

      const turno = await bookOk({ serviceIds: [serviceId, segundo] });

      expect(turno).toMatchObject({
        endsAt: enBuenosAires('11:30'), // 60 + 30
        totalPriceCents: 150_000,
      });
      expect(turno.services).toHaveLength(2);
    });

    it('guarda las notas', async () => {
      const turno = await bookOk({ notes: 'Viene con su hija' });

      expect(turno.notes).toBe('Viene con su hija');
    });

    it.each([
      ['un cliente que no existe', { customerId: randomUUID() }],
      ['un servicio que no existe', { serviceIds: [randomUUID()] }],
      ['servicios repetidos', {}],
    ])('rechaza %s con 400', async (caso, body) => {
      const payload =
        caso === 'servicios repetidos'
          ? { serviceIds: [serviceId, serviceId] }
          : body;

      await book(payload).expect(400);
    });

    it('rechaza a un profesional que no presta ese servicio ahí', async () => {
      const otro = await createProfessional('Marina');

      await book({ employeeId: otro }).expect(400);
    });

    it('rechaza un servicio desactivado', async () => {
      await request(server())
        .patch(`/services/${serviceId}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      await book().expect(400);
    });
  });

  describe('Con seña', () => {
    beforeEach(async () => {
      serviceId = await createService({
        priceCents: 100_000,
        depositAmountCents: 30_000,
      });
      await assign(serviceId, [{ employeeId, branchId }]);
    });

    it('sin exigir seña, el turno nace confirmado', async () => {
      const turno = await bookOk();

      expect(turno).toMatchObject({
        status: AppointmentStatus.CONFIRMED,
        depositAmountCents: 30_000,
      });
    });

    it('exigiendo seña, nace esperando el pago', async () => {
      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ requireDepositForBooking: true })
        .expect(200);

      expect((await bookOk()).status).toBe(AppointmentStatus.PENDING_PAYMENT);
    });

    it('un servicio sin seña se confirma aunque el negocio la exija', async () => {
      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ requireDepositForBooking: true })
        .expect(200);

      const sinSeña = await createService({ priceCents: 100_000 });
      await assign(sinSeña, [{ employeeId, branchId }]);

      expect((await bookOk({ serviceIds: [sinSeña] })).status).toBe(
        AppointmentStatus.CONFIRMED,
      );
    });
  });

  describe('El horario tiene que estar libre', () => {
    it('rechaza fuera del horario de atención', async () => {
      await book({ startsAt: enBuenosAires('20:00') }).expect(409);
    });

    it('rechaza un horario que se pisa con otro turno', async () => {
      await bookOk({ startsAt: enBuenosAires('10:00') });

      await book({ startsAt: enBuenosAires('10:30') }).expect(409);
    });

    it('acepta un turno pegado al anterior', async () => {
      await bookOk({ startsAt: enBuenosAires('10:00') });

      await book({ startsAt: enBuenosAires('11:00') }).expect(201);
    });

    it('el turno de un profesional no molesta al de otro', async () => {
      const otro = await createProfessional('Marina');
      await assign(serviceId, [
        { employeeId, branchId },
        { employeeId: otro, branchId },
      ]);

      await bookOk({ startsAt: enBuenosAires('10:00') });

      await book({ employeeId: otro, startsAt: enBuenosAires('10:00') }).expect(
        201,
      );
    });

    /**
     * El caso que el roadmap marca como criterio de cierre de la fase. Las dos
     * requests pasan la validación previa (cuando miran, el hueco está libre) y
     * la que desempata es la base con su EXCLUDE constraint.
     */
    it('dos reservas simultáneas al mismo hueco: una entra y la otra no', async () => {
      const otroCliente = await createCustomer();

      const [a, b] = await Promise.all([
        book({ startsAt: enBuenosAires('14:00') }),
        book({ startsAt: enBuenosAires('14:00'), customerId: otroCliente }),
      ]);

      const codigos = [a.status, b.status].sort();

      expect(codigos).toEqual([201, 409]);

      const agendados = await prisma.appointment.count({
        where: {
          tenantId: tenant.tenantId,
          startsAt: new Date(enBuenosAires('14:00')),
        },
      });

      expect(agendados).toBe(1);
    });
  });

  describe('Recursos', () => {
    let resourceId: string;
    let otro: string;

    beforeEach(async () => {
      const recurso = await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sala de color', branchId })
        .expect(201);

      resourceId = (recurso.body as { id: string }).id;

      await request(server())
        .put(`/services/${serviceId}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [resourceId] })
        .expect(200);

      otro = await createProfessional('Marina');
      await assign(serviceId, [
        { employeeId, branchId },
        { employeeId: otro, branchId },
      ]);
    });

    it('el turno reserva el recurso que el servicio necesita', async () => {
      const turno = await bookOk();

      expect(turno.resources).toEqual([{ resourceId, name: 'Sala de color' }]);
    });

    /** Dos profesionales libres, pero una sola sala. */
    it('el recurso ocupado bloquea a otro profesional', async () => {
      await bookOk({ startsAt: enBuenosAires('10:00') });

      await book({ employeeId: otro, startsAt: enBuenosAires('10:00') }).expect(
        409,
      );
    });

    it('cancelar libera el recurso', async () => {
      const turno = await bookOk({ startsAt: enBuenosAires('10:00') });

      await request(server())
        .patch(`/appointments/${turno.id}/status`)
        .set(...auth(tenant.accessToken))
        .send({ status: AppointmentStatus.CANCELED_BY_CUSTOMER })
        .expect(200);

      await book({ employeeId: otro, startsAt: enBuenosAires('10:00') }).expect(
        201,
      );
    });
  });

  describe('La agenda', () => {
    const listar = async (
      query: Record<string, string> = {},
    ): Promise<AppointmentResponse[]> => {
      const params = new URLSearchParams({
        from: LUNES,
        to: MARTES,
        ...query,
      });

      const response = await request(server())
        .get(`/appointments?${params.toString()}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      return response.body as AppointmentResponse[];
    };

    it('trae los turnos del rango ordenados por hora', async () => {
      await bookOk({ startsAt: enBuenosAires('14:00') });
      await bookOk({ startsAt: enBuenosAires('10:00') });

      expect((await listar()).map((turno) => turno.startsAt)).toEqual([
        enBuenosAires('10:00'),
        enBuenosAires('14:00'),
      ]);
    });

    it('deja afuera lo que no entra en el rango', async () => {
      await bookOk({ startsAt: enBuenosAires('10:00', MARTES) });

      expect(await listar({ to: LUNES })).toEqual([]);
    });

    it('filtra por profesional', async () => {
      const otro = await createProfessional('Marina');
      await assign(serviceId, [
        { employeeId, branchId },
        { employeeId: otro, branchId },
      ]);

      await bookOk({ startsAt: enBuenosAires('10:00') });
      await bookOk({ employeeId: otro, startsAt: enBuenosAires('12:00') });

      const soloOtro = await listar({ employeeId: otro });

      expect(soloOtro).toHaveLength(1);
      expect(soloOtro[0].employee.id).toBe(otro);
    });

    it('filtra por estado', async () => {
      const turno = await bookOk({ startsAt: enBuenosAires('10:00') });
      await bookOk({ startsAt: enBuenosAires('12:00') });

      await request(server())
        .patch(`/appointments/${turno.id}/status`)
        .set(...auth(tenant.accessToken))
        .send({ status: AppointmentStatus.CANCELED_BY_BUSINESS })
        .expect(200);

      expect(
        await listar({ status: AppointmentStatus.CONFIRMED }),
      ).toHaveLength(1);
      expect(await listar()).toHaveLength(2);
    });

    it('rechaza un rango al revés', async () => {
      await request(server())
        .get(`/appointments?from=${MARTES}&to=${LUNES}`)
        .set(...auth(tenant.accessToken))
        .expect(400);
    });

    it('rechaza un rango desmedido', async () => {
      await request(server())
        .get(`/appointments?from=${LUNES}&to=2027-09-07`)
        .set(...auth(tenant.accessToken))
        .expect(400);
    });

    it('no trae turnos de otro negocio', async () => {
      await bookOk();
      const otro = await registerTenant(app, 'Otro Negocio');

      const response = await request(server())
        .get(`/appointments?from=${LUNES}&to=${MARTES}`)
        .set(...auth(otro.accessToken))
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('404 al leer un turno de otro negocio', async () => {
      const turno = await bookOk();
      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .get(`/appointments/${turno.id}`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });
  });

  describe('Cambios de estado', () => {
    const cambiar = (id: string, body: Record<string, unknown>): request.Test =>
      request(server())
        .patch(`/appointments/${id}/status`)
        .set(...auth(tenant.accessToken))
        .send(body);

    it('un turno confirmado se marca atendido', async () => {
      const turno = await bookOk();

      const response = await cambiar(turno.id, {
        status: AppointmentStatus.ATTENDED,
      }).expect(200);

      const resultado = response.body as ChangeStatusResult;

      expect(resultado.appointment.status).toBe(AppointmentStatus.ATTENDED);
      expect(resultado.refund).toBeNull();
    });

    it('un turno confirmado se marca como ausente', async () => {
      const turno = await bookOk();

      await cambiar(turno.id, { status: AppointmentStatus.NO_SHOW }).expect(
        200,
      );
    });

    it('rechaza volver atrás desde un estado final', async () => {
      const turno = await bookOk();

      await cambiar(turno.id, { status: AppointmentStatus.ATTENDED }).expect(
        200,
      );
      await cambiar(turno.id, { status: AppointmentStatus.CONFIRMED }).expect(
        409,
      );
    });

    it('rechaza confirmar un turno que ya está confirmado', async () => {
      const turno = await bookOk();

      await cambiar(turno.id, { status: AppointmentStatus.CONFIRMED }).expect(
        409,
      );
    });

    it('a rescheduled no se llega por acá', async () => {
      const turno = await bookOk();

      await cambiar(turno.id, { status: AppointmentStatus.RESCHEDULED }).expect(
        400,
      );
    });

    describe('cancelar', () => {
      it('sella la fecha y el motivo', async () => {
        const turno = await bookOk();

        const response = await cambiar(turno.id, {
          status: AppointmentStatus.CANCELED_BY_CUSTOMER,
          cancellationReason: 'Se enfermó',
        }).expect(200);

        const { appointment } = response.body as ChangeStatusResult;

        expect(appointment.status).toBe(AppointmentStatus.CANCELED_BY_CUSTOMER);
        expect(appointment.canceledAt).not.toBeNull();
        expect(appointment.cancellationReason).toBe('Se enfermó');
      });

      it('libera el hueco en la agenda', async () => {
        const turno = await bookOk({ startsAt: enBuenosAires('10:00') });

        await book({ startsAt: enBuenosAires('10:00') }).expect(409);

        await cambiar(turno.id, {
          status: AppointmentStatus.CANCELED_BY_BUSINESS,
        }).expect(200);

        await book({ startsAt: enBuenosAires('10:00') }).expect(201);
      });

      it('sin seña pagada no hay nada que devolver', async () => {
        const turno = await bookOk();

        const response = await cambiar(turno.id, {
          status: AppointmentStatus.CANCELED_BY_CUSTOMER,
        }).expect(200);

        expect((response.body as ChangeStatusResult).refund).toMatchObject({
          type: 'NONE',
          amountCents: 0,
          withinPolicy: true,
        });
      });

      it('con seña pagada y en término, corresponde devolverla', async () => {
        const conSeña = await createService({
          priceCents: 100_000,
          depositAmountCents: 30_000,
        });
        await assign(conSeña, [{ employeeId, branchId }]);

        const turno = await bookOk({ serviceIds: [conSeña] });

        // Todavía no hay endpoint de pagos: eso es la Fase 6.
        await prisma.appointment.update({
          where: { id: turno.id },
          data: { depositPaid: true },
        });

        const response = await cambiar(turno.id, {
          status: AppointmentStatus.CANCELED_BY_CUSTOMER,
        }).expect(200);

        expect((response.body as ChangeStatusResult).refund).toMatchObject({
          type: 'FULL',
          amountCents: 30_000,
          withinPolicy: true,
        });
      });

      it('fuera de término no corresponde devolución', async () => {
        const conSeña = await createService({
          priceCents: 100_000,
          depositAmountCents: 30_000,
        });
        await assign(conSeña, [{ employeeId, branchId }]);

        const turno = await bookOk({ serviceIds: [conSeña] });

        // Se acerca el turno a dentro de una hora en vez de estirar la política
        // del negocio: así el test no depende de qué día se corra. Va por
        // Prisma porque mover el horario desde la API sería reprogramar, que es
        // otra cosa. El servicio no usa recursos, así que no hay espejo que
        // desincronizar.
        await prisma.appointment.update({
          where: { id: turno.id },
          data: {
            startsAt: new Date(Date.now() + 60 * 60 * 1000),
            endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
            depositPaid: true,
          },
        });

        const response = await cambiar(turno.id, {
          status: AppointmentStatus.CANCELED_BY_CUSTOMER,
        }).expect(200);

        expect((response.body as ChangeStatusResult).refund).toMatchObject({
          type: 'NONE',
          amountCents: 0,
          withinPolicy: false,
        });
      });
    });
  });

  describe('Reprogramar', () => {
    const mover = (id: string, body: Record<string, unknown>): request.Test =>
      request(server())
        .post(`/appointments/${id}/reschedule`)
        .set(...auth(tenant.accessToken))
        .send(body);

    it('crea uno nuevo y deja el viejo enlazado', async () => {
      const viejo = await bookOk({ startsAt: enBuenosAires('10:00') });

      const response = await mover(viejo.id, {
        startsAt: enBuenosAires('15:00'),
        reason: 'Pidió cambiarlo',
      }).expect(201);

      const nuevo = response.body as AppointmentResponse;

      expect(nuevo).toMatchObject({
        startsAt: enBuenosAires('15:00'),
        endsAt: enBuenosAires('16:00'),
        rescheduledFromId: viejo.id,
      });

      const leido = await request(server())
        .get(`/appointments/${viejo.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(leido.body).toMatchObject({
        status: AppointmentStatus.RESCHEDULED,
        rescheduledToId: nuevo.id,
      });
    });

    it('libera el horario viejo', async () => {
      const viejo = await bookOk({ startsAt: enBuenosAires('10:00') });

      await mover(viejo.id, { startsAt: enBuenosAires('15:00') }).expect(201);

      await book({ startsAt: enBuenosAires('10:00') }).expect(201);
    });

    /** El turno no se pisa a sí mismo: se excluye del cálculo. */
    it('mover un turno un rato más tarde, solapándose consigo mismo, funciona', async () => {
      const viejo = await bookOk({ startsAt: enBuenosAires('10:00') });

      await mover(viejo.id, { startsAt: enBuenosAires('10:30') }).expect(201);
    });

    it('mantiene el precio que se había acordado', async () => {
      const viejo = await bookOk();

      await request(server())
        .patch(`/services/${serviceId}`)
        .set(...auth(tenant.accessToken))
        .send({ priceCents: 999_999 })
        .expect(200);

      const response = await mover(viejo.id, {
        startsAt: enBuenosAires('15:00'),
      }).expect(201);

      expect(
        (response.body as AppointmentResponse).services[0].priceCents,
      ).toBe(100_000);
    });

    it('puede cambiar de profesional', async () => {
      const otro = await createProfessional('Marina');
      await assign(serviceId, [
        { employeeId, branchId },
        { employeeId: otro, branchId },
      ]);

      const viejo = await bookOk();

      const response = await mover(viejo.id, {
        startsAt: enBuenosAires('15:00'),
        employeeId: otro,
      }).expect(201);

      expect((response.body as AppointmentResponse).employee.id).toBe(otro);
    });

    it('rechaza pasarlo a alguien que no presta ese servicio', async () => {
      const otro = await createProfessional('Marina');
      const viejo = await bookOk();

      await mover(viejo.id, {
        startsAt: enBuenosAires('15:00'),
        employeeId: otro,
      }).expect(400);
    });

    it('rechaza un horario ocupado', async () => {
      const viejo = await bookOk({ startsAt: enBuenosAires('10:00') });
      await bookOk({ startsAt: enBuenosAires('15:00') });

      await mover(viejo.id, { startsAt: enBuenosAires('15:00') }).expect(409);
    });

    it('rechaza reprogramar un turno ya cerrado', async () => {
      const turno = await bookOk();

      await request(server())
        .patch(`/appointments/${turno.id}/status`)
        .set(...auth(tenant.accessToken))
        .send({ status: AppointmentStatus.ATTENDED })
        .expect(200);

      await mover(turno.id, { startsAt: enBuenosAires('15:00') }).expect(409);
    });
  });

  describe('Notas y permisos', () => {
    it('edita solo las notas', async () => {
      const turno = await bookOk();

      const response = await request(server())
        .patch(`/appointments/${turno.id}`)
        .set(...auth(tenant.accessToken))
        .send({ notes: 'Alérgica al amoníaco' })
        .expect(200);

      expect(response.body).toMatchObject({
        notes: 'Alérgica al amoníaco',
        startsAt: turno.startsAt,
      });
    });

    it('rechaza mover el horario con un PATCH', async () => {
      const turno = await bookOk();

      await request(server())
        .patch(`/appointments/${turno.id}`)
        .set(...auth(tenant.accessToken))
        .send({ startsAt: enBuenosAires('15:00') })
        .expect(400);
    });

    it('401 sin token', async () => {
      await request(server()).post('/appointments').send({}).expect(401);
    });
  });
});
