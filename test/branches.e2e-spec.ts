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

/**
 * Una semana válida: domingo cerrado, el resto de 09:00 a 18:00.
 *
 * Los overrides REEMPLAZAN el día entero en vez de mezclarse con él: si no, un
 * día que en la base viene cerrado se quedaría con su `isClosed: true` y el
 * override de horarios no tendría efecto.
 */
function week(
  overrides: Record<number, Record<string, unknown>> = {},
): Record<string, unknown>[] {
  return Array.from(
    { length: 7 },
    (_, dayOfWeek) =>
      overrides[dayOfWeek] ?? {
        dayOfWeek,
        ...(dayOfWeek === 0
          ? { isClosed: true }
          : { opensAt: '09:00', closesAt: '18:00' }),
      },
  );
}

describe('Branches (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
  });

  const server = () => app.getHttpServer();

  async function createBranch(
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; businessHours: { dayOfWeek: number }[] }> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(token))
      .send({ name: 'Sucursal Centro', ...body })
      .expect(201);

    return response.body as {
      id: string;
      businessHours: { dayOfWeek: number }[];
    };
  }

  describe('POST /branches', () => {
    it('crea la sucursal con la semana por defecto', async () => {
      const response = await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Centro', address: 'Av. Corrientes 1234' })
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'Sucursal Centro',
        address: 'Av. Corrientes 1234',
        phone: null,
        isActive: true,
      });

      const { businessHours } = response.body as {
        businessHours: {
          dayOfWeek: number;
          isClosed: boolean;
          opensAt: string | null;
          closesAt: string | null;
        }[];
      };

      expect(businessHours).toHaveLength(7);
      expect(businessHours[1]).toEqual({
        dayOfWeek: 1,
        isClosed: false,
        opensAt: '09:00',
        closesAt: '18:00',
      });
      expect(
        businessHours.filter((d) => d.isClosed).map((d) => d.dayOfWeek),
      ).toEqual([0, 6]);
    });

    it('acepta un horario propio en el alta', async () => {
      const response = await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Sucursal Palermo',
          businessHours: week({
            6: { dayOfWeek: 6, opensAt: '10:00', closesAt: '14:00' },
          }),
        })
        .expect(201);

      const { businessHours } = response.body as {
        businessHours: { dayOfWeek: number; opensAt: string | null }[];
      };
      expect(businessHours[6]).toMatchObject({
        opensAt: '10:00',
        closesAt: '14:00',
      });
    });

    it('rechaza el nombre vacío y el body con campos de más', async () => {
      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: '   ' })
        .expect(400);

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Centro', tenantId: 'otro-negocio' })
        .expect(400);
    });

    it('exige token', async () => {
      await request(server())
        .post('/branches')
        .send({ name: 'Sucursal Centro' })
        .expect(401);
    });
  });

  describe('Límite del plan', () => {
    it('el plan básico permite una sola sucursal', async () => {
      await createBranch(tenant.accessToken);

      const response = await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Palermo' })
        .expect(403);

      expect(JSON.stringify(response.body)).toContain('Básico');

      const listed = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listed.body).toHaveLength(1);
    });

    it('con un plan sin tope se pueden crear varias', async () => {
      await switchPlan(prisma, tenant.tenantId, 'empresa');

      await createBranch(tenant.accessToken, { name: 'Sucursal Centro' });
      await createBranch(tenant.accessToken, { name: 'Sucursal Palermo' });
      await createBranch(tenant.accessToken, { name: 'Sucursal Caballito' });

      const listed = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listed.body).toHaveLength(3);
    });

    it('una sucursal desactivada sigue ocupando lugar del plan', async () => {
      const branch = await createBranch(tenant.accessToken);

      await request(server())
        .patch(`/branches/${branch.id}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Palermo' })
        .expect(403);
    });

    /**
     * La razón de ser del `FOR UPDATE` sobre la fila del negocio: sin él, las
     * cinco altas cuentan 0 sucursales al mismo tiempo, las cinco ven lugar y
     * las cinco insertan. Este test solo tiene sentido contra Postgres real.
     */
    it('cinco altas simultáneas no se saltean el límite del plan', async () => {
      const intentos = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(server())
            .post('/branches')
            .set(...auth(tenant.accessToken))
            .send({ name: `Sucursal ${i}` }),
        ),
      );

      const creadas = intentos.filter((r) => r.status === 201);
      const rechazadas = intentos.filter((r) => r.status === 403);

      expect(creadas).toHaveLength(1);
      expect(rechazadas).toHaveLength(4);

      const listado = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listado.body).toHaveLength(1);
    });

    it('borrarla sí libera el lugar', async () => {
      const branch = await createBranch(tenant.accessToken);

      await request(server())
        .delete(`/branches/${branch.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Palermo' })
        .expect(201);
    });
  });

  describe('Nombre repetido', () => {
    beforeEach(async () => {
      await switchPlan(prisma, tenant.tenantId, 'empresa');
    });

    it('no deja dos sucursales con el mismo nombre', async () => {
      await createBranch(tenant.accessToken, { name: 'Sucursal Centro' });

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Centro' })
        .expect(409);
    });

    it('tampoco si solo cambian las mayúsculas', async () => {
      await createBranch(tenant.accessToken, { name: 'Sucursal Centro' });

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'sucursal centro' })
        .expect(409);
    });

    it('borrar una libera el nombre', async () => {
      const branch = await createBranch(tenant.accessToken, {
        name: 'Sucursal Centro',
      });

      await request(server())
        .delete(`/branches/${branch.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Centro' })
        .expect(201);
    });

    it('dos negocios distintos sí pueden llamarlas igual', async () => {
      const otro = await registerTenant(app, 'Estética Norte');

      await createBranch(tenant.accessToken, { name: 'Sucursal Centro' });
      await createBranch(otro.accessToken, { name: 'Sucursal Centro' });
    });
  });

  describe('GET /branches', () => {
    beforeEach(async () => {
      await switchPlan(prisma, tenant.tenantId, 'empresa');
    });

    it('ordena por nombre y filtra por estado', async () => {
      const palermo = await createBranch(tenant.accessToken, {
        name: 'Sucursal Palermo',
      });
      await createBranch(tenant.accessToken, { name: 'Sucursal Centro' });

      await request(server())
        .patch(`/branches/${palermo.id}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      const todas = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect((todas.body as { name: string }[]).map((b) => b.name)).toEqual([
        'Sucursal Centro',
        'Sucursal Palermo',
      ]);

      const activas = await request(server())
        .get('/branches?isActive=true')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect((activas.body as { name: string }[]).map((b) => b.name)).toEqual([
        'Sucursal Centro',
      ]);
    });

    it('rechaza un filtro que no es booleano', async () => {
      await request(server())
        .get('/branches?isActive=quizás')
        .set(...auth(tenant.accessToken))
        .expect(400);
    });

    it('una sucursal borrada desaparece de la lista', async () => {
      const branch = await createBranch(tenant.accessToken);

      await request(server())
        .delete(`/branches/${branch.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const listed = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listed.body).toEqual([]);

      await request(server())
        .get(`/branches/${branch.id}`)
        .set(...auth(tenant.accessToken))
        .expect(404);
    });

    it('rechaza un id que no es UUID', async () => {
      await request(server())
        .get('/branches/no-es-un-uuid')
        .set(...auth(tenant.accessToken))
        .expect(400);
    });
  });

  describe('PUT /branches/:id/business-hours', () => {
    let branchId: string;

    beforeEach(async () => {
      branchId = (await createBranch(tenant.accessToken)).id;
    });

    it('reemplaza la semana entera', async () => {
      const response = await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({
          days: week({
            0: { dayOfWeek: 0, opensAt: '11:00', closesAt: '16:00' },
            3: { dayOfWeek: 3, isClosed: true },
          }),
        })
        .expect(200);

      const days = response.body as {
        dayOfWeek: number;
        isClosed: boolean;
        opensAt: string | null;
      }[];

      expect(days).toHaveLength(7);
      expect(days[0]).toMatchObject({ isClosed: false, opensAt: '11:00' });
      expect(days[3]).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('exige los 7 días', async () => {
      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({ days: week().slice(0, 5) })
        .expect(400);
    });

    it('rechaza que cierre antes de abrir', async () => {
      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({
          days: week({
            1: { dayOfWeek: 1, opensAt: '18:00', closesAt: '09:00' },
          }),
        })
        .expect(400);
    });

    it('rechaza una hora mal escrita', async () => {
      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({
          days: week({
            1: { dayOfWeek: 1, opensAt: '9am', closesAt: '18:00' },
          }),
        })
        .expect(400);
    });

    it('en un día cerrado ignora las horas que le manden', async () => {
      const response = await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({
          days: week({
            2: {
              dayOfWeek: 2,
              isClosed: true,
              opensAt: '09:00',
              closesAt: '18:00',
            },
          }),
        })
        .expect(200);

      expect((response.body as { isClosed: boolean }[])[2]).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('si la semana viene mal, no pisa la anterior', async () => {
      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({ days: week().slice(0, 3) })
        .expect(400);

      const actual = await request(server())
        .get(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(actual.body).toHaveLength(7);
    });
  });

  describe('Días especiales', () => {
    let branchId: string;

    beforeEach(async () => {
      branchId = (await createBranch(tenant.accessToken)).id;
    });

    it('carga un feriado y lo lista', async () => {
      const created = await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25', description: 'Navidad' })
        .expect(201);

      expect(created.body).toMatchObject({
        date: '2026-12-25',
        isClosed: true,
        opensAt: null,
        closesAt: null,
        description: 'Navidad',
      });

      const listed = await request(server())
        .get(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listed.body).toHaveLength(1);
    });

    it('carga una jornada con horario especial', async () => {
      const created = await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({
          date: '2026-12-24',
          isClosed: false,
          opensAt: '09:00',
          closesAt: '13:00',
          description: 'Nochebuena: cerramos temprano',
        })
        .expect(201);

      expect(created.body).toMatchObject({
        date: '2026-12-24',
        isClosed: false,
        opensAt: '09:00',
        closesAt: '13:00',
      });
    });

    it('una jornada abierta sin horario no pasa', async () => {
      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-24', isClosed: false })
        .expect(400);
    });

    it('rechaza una fecha que no existe', async () => {
      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-02-30' })
        .expect(400);
    });

    it('no deja dos días especiales en la misma fecha', async () => {
      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25' })
        .expect(201);

      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25' })
        .expect(409);
    });

    it('filtra por rango de fechas', async () => {
      for (const date of ['2026-01-01', '2026-06-20', '2026-12-25']) {
        await request(server())
          .post(`/branches/${branchId}/special-days`)
          .set(...auth(tenant.accessToken))
          .send({ date })
          .expect(201);
      }

      const response = await request(server())
        .get(`/branches/${branchId}/special-days?from=2026-06-01&to=2026-12-24`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as { date: string }[]).map((d) => d.date)).toEqual([
        '2026-06-20',
      ]);
    });

    it('cerrar un día que tenía horario le limpia las horas', async () => {
      const created = await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({
          date: '2026-12-24',
          isClosed: false,
          opensAt: '09:00',
          closesAt: '13:00',
        })
        .expect(201);

      const { id } = created.body as { id: string };

      const updated = await request(server())
        .patch(`/branches/${branchId}/special-days/${id}`)
        .set(...auth(tenant.accessToken))
        .send({ isClosed: true })
        .expect(200);

      expect(updated.body).toMatchObject({
        isClosed: true,
        opensAt: null,
        closesAt: null,
      });
    });

    it('lo borra', async () => {
      const created = await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25' })
        .expect(201);

      const { id } = created.body as { id: string };

      await request(server())
        .delete(`/branches/${branchId}/special-days/${id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const listed = await request(server())
        .get(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect(listed.body).toEqual([]);
    });
  });

  describe('Autorización por rol', () => {
    let branchId: string;

    beforeEach(async () => {
      branchId = (await createBranch(tenant.accessToken)).id;
    });

    it('un PROFESSIONAL lee pero no escribe', async () => {
      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { role: 'PROFESSIONAL' },
      });

      await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);

      await request(server())
        .get(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Palermo' })
        .expect(403);

      await request(server())
        .patch(`/branches/${branchId}`)
        .set(...auth(tenant.accessToken))
        .send({ name: 'Renombrada sin permiso' })
        .expect(403);

      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({ days: week() })
        .expect(403);

      await request(server())
        .post(`/branches/${branchId}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25' })
        .expect(403);

      await request(server())
        .delete(`/branches/${branchId}`)
        .set(...auth(tenant.accessToken))
        .expect(403);
    });

    it('un ADMINISTRATIVE sí puede escribir', async () => {
      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { role: 'ADMINISTRATIVE' },
      });

      await request(server())
        .patch(`/branches/${branchId}`)
        .set(...auth(tenant.accessToken))
        .send({ name: 'Sucursal Centro Renovada' })
        .expect(200);
    });
  });

  describe('Aislamiento entre negocios', () => {
    let otro: RegisteredTenant;
    let branchId: string;
    let branchDelOtro: string;

    beforeEach(async () => {
      otro = await registerTenant(app, 'Estética Norte');
      branchId = (await createBranch(tenant.accessToken)).id;
      branchDelOtro = (
        await createBranch(otro.accessToken, { name: 'Sucursal Norte' })
      ).id;
    });

    it('cada uno ve solo sus sucursales', async () => {
      const mias = await request(server())
        .get('/branches')
        .set(...auth(tenant.accessToken))
        .expect(200);
      expect((mias.body as { name: string }[]).map((b) => b.name)).toEqual([
        'Sucursal Centro',
      ]);

      const ajenas = await request(server())
        .get('/branches')
        .set(...auth(otro.accessToken))
        .expect(200);
      expect((ajenas.body as { name: string }[]).map((b) => b.name)).toEqual([
        'Sucursal Norte',
      ]);
    });

    it('la sucursal del otro negocio no existe para mí', async () => {
      await request(server())
        .get(`/branches/${branchDelOtro}`)
        .set(...auth(tenant.accessToken))
        .expect(404);

      await request(server())
        .patch(`/branches/${branchDelOtro}`)
        .set(...auth(tenant.accessToken))
        .send({ name: 'Secuestrada' })
        .expect(404);

      await request(server())
        .delete(`/branches/${branchDelOtro}`)
        .set(...auth(tenant.accessToken))
        .expect(404);

      await request(server())
        .put(`/branches/${branchDelOtro}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({ days: week() })
        .expect(404);
    });

    it('tampoco se le pueden colgar días especiales', async () => {
      await request(server())
        .post(`/branches/${branchDelOtro}/special-days`)
        .set(...auth(tenant.accessToken))
        .send({ date: '2026-12-25' })
        .expect(404);

      await request(server())
        .get(`/branches/${branchDelOtro}/special-days`)
        .set(...auth(tenant.accessToken))
        .expect(404);
    });

    it('un día especial de otra sucursal no se toca por id', async () => {
      const created = await request(server())
        .post(`/branches/${branchDelOtro}/special-days`)
        .set(...auth(otro.accessToken))
        .send({ date: '2026-12-25' })
        .expect(201);

      const { id } = created.body as { id: string };

      // Mismo id de día especial, pero colgado de MI sucursal: no existe.
      await request(server())
        .patch(`/branches/${branchId}/special-days/${id}`)
        .set(...auth(tenant.accessToken))
        .send({ description: 'Ajeno' })
        .expect(404);

      await request(server())
        .delete(`/branches/${branchId}/special-days/${id}`)
        .set(...auth(tenant.accessToken))
        .expect(404);
    });

    it('el horario que edita uno no toca al del otro', async () => {
      await request(server())
        .put(`/branches/${branchId}/business-hours`)
        .set(...auth(tenant.accessToken))
        .send({
          days: week({
            1: { dayOfWeek: 1, opensAt: '07:00', closesAt: '12:00' },
          }),
        })
        .expect(200);

      const intacto = await request(server())
        .get(`/branches/${branchDelOtro}/business-hours`)
        .set(...auth(otro.accessToken))
        .expect(200);

      expect((intacto.body as { opensAt: string }[])[1]).toMatchObject({
        opensAt: '09:00',
        closesAt: '18:00',
      });
    });
  });

  /**
   * La validación del service devuelve 400 con un mensaje claro; estos CHECK
   * son la red de abajo, para cuando el que escriba sea un job, un seed o una
   * query a mano que se saltee el service.
   */
  describe('Red de seguridad de la base', () => {
    it('Postgres rechaza un día abierto sin horario', async () => {
      const branch = await createBranch(tenant.accessToken);

      await expect(
        prisma.$executeRaw`
          INSERT INTO branch_business_hours (tenant_id, branch_id, day_of_week, is_closed, updated_at)
          VALUES (${tenant.tenantId}::uuid, ${branch.id}::uuid, 1, false, now())
        `,
      ).rejects.toThrow(/branch_business_hours_hours_check/);
    });

    it('Postgres rechaza que cierre antes de abrir', async () => {
      const branch = await createBranch(tenant.accessToken);

      await expect(
        prisma.$executeRaw`
          INSERT INTO branch_special_days (tenant_id, branch_id, date, is_closed, opens_at, closes_at, updated_at)
          VALUES (${tenant.tenantId}::uuid, ${branch.id}::uuid, '2026-12-25', false, '18:00', '09:00', now())
        `,
      ).rejects.toThrow(/branch_special_days_hours_check/);
    });

    it('Postgres rechaza un día de la semana fuera de rango', async () => {
      const branch = await createBranch(tenant.accessToken);

      await expect(
        prisma.$executeRaw`
          INSERT INTO branch_business_hours (tenant_id, branch_id, day_of_week, is_closed, updated_at)
          VALUES (${tenant.tenantId}::uuid, ${branch.id}::uuid, 7, true, now())
        `,
      ).rejects.toThrow(/day_of_week/);
    });
  });
});
