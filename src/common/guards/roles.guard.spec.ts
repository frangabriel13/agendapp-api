import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { EmployeeRole } from '@prisma/client';
import type { AuthenticatedUser } from '../../modules/auth/types/jwt-payload';
import { RolesGuard } from './roles.guard';

const user = (role: EmployeeRole): AuthenticatedUser => ({
  userId: 'u1',
  email: 'test@negocio.test',
  tenantId: 't1',
  employeeId: 'e1',
  role,
});

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };

  const contextWith = (current?: AuthenticatedUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user: current }) }),
      getHandler: () => jest.fn(),
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('deja pasar si el handler no declara roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(
      guard.canActivate(contextWith(user(EmployeeRole.PROFESSIONAL))),
    ).toBe(true);
  });

  it('deja pasar si el rol del usuario está en la lista', () => {
    reflector.getAllAndOverride.mockReturnValue([
      EmployeeRole.OWNER,
      EmployeeRole.ADMINISTRATIVE,
    ]);
    expect(guard.canActivate(contextWith(user(EmployeeRole.OWNER)))).toBe(true);
  });

  it('corta con 403 si el rol no alcanza', () => {
    reflector.getAllAndOverride.mockReturnValue([EmployeeRole.OWNER]);
    expect(() =>
      guard.canActivate(contextWith(user(EmployeeRole.PROFESSIONAL))),
    ).toThrow(ForbiddenException);
  });

  it('corta con 401 si la ruta pide roles pero no hay usuario', () => {
    reflector.getAllAndOverride.mockReturnValue([EmployeeRole.OWNER]);
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
