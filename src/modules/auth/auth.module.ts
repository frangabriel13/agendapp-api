import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { Env } from '../../config/env.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UserTokenService } from './user-token.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          expiresIn: config.get('JWT_ACCESS_EXPIRES_IN', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    RefreshTokenService,
    UserTokenService,
    JwtStrategy,
  ],
  // `JwtAuthGuard` está montado como guard global en AppModule y resuelve la
  // estrategia 'jwt' que registra `JwtStrategy` acá.
  // `PasswordService` sale afuera para que la activación de un empleado hashee
  // con el mismo algoritmo y los mismos parámetros que el registro.
  exports: [PassportModule, JwtModule, PasswordService],
})
export class AuthModule {}
