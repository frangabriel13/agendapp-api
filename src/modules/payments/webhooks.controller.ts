import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookResultDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

/**
 * Mercado Pago avisa en ráfagas y reintenta, así que el límite global (10/s,
 * 100/min) le queda corto. Sigue habiendo tope porque es un endpoint público:
 * la firma se verifica antes de tocar la base, y un HMAC es barato, pero no
 * gratis.
 */
const WEBHOOK_THROTTLE = {
  short: { limit: 30, ttl: 1_000 },
  long: { limit: 600, ttl: 60_000 },
};

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * **Contesta 200 casi siempre, y eso es a propósito.** Mercado Pago reintenta
   * ante cualquier respuesta que no sea 2xx, así que un error solo tiene
   * sentido cuando reintentar puede servir: si el proveedor no contestó (502).
   * Un aviso que no es de un pago, o de un pago que no es nuestro, se contesta
   * 200 — reintentarlo no va a cambiar nada y solo genera ruido.
   *
   * La excepción es la firma inválida: ahí va 401, porque no es un aviso
   * legítimo que salió mal, es uno que no vino de quien dice.
   */
  @Post('mercadopago')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(WEBHOOK_THROTTLE)
  @ApiOperation({
    summary: 'Aviso de pago de Mercado Pago',
    description:
      'No lo llama el frontend: lo llama Mercado Pago. Está en el spec igual ' +
      'porque es parte del contrato de quien configura el webhook, y ocultarlo ' +
      'no lo haría más seguro — de eso se ocupa la firma.',
  })
  @ApiOkResponse({ type: WebhookResultDto })
  @ApiUnauthorizedResponse({ description: 'La firma no verifica' })
  @ApiBadGatewayResponse({
    description: 'El proveedor no respondió: que reintente',
  })
  mercadoPago(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query() query: Record<string, string | undefined>,
    @Body() body: unknown,
  ): Promise<WebhookResultDto> {
    return this.payments.handleWebhook({ headers, query, body });
  }
}
