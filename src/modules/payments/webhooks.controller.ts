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
import { WEBHOOK_THROTTLE } from '../../config/throttler.config';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookResultDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

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
