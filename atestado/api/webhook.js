// POST /api/webhook
// Recebe notificações da MasterPag (charge.paid, charge.failed, etc.).
// Valida a assinatura HMAC-SHA256 quando há um secret configurado.

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const secret = process.env.MASTERPAG_WEBHOOK_SECRET;
    const rawSig = req.headers['x-webhook-signature'];

    // Validação de assinatura (recomendada). Se a sua secret estiver configurada,
    // exigimos a assinatura. Obs: a MasterPag assina o corpo; se a validação falhar
    // de forma consistente, pode ser necessário validar sobre o corpo bruto (raw body).
    if (secret) {
      if (!rawSig) {
        res.status(401).json({ error: 'Assinatura ausente.' });
        return;
      }
      const sig = String(rawSig).replace('sha256=', '');
      const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Assinatura inválida.' });
        return;
      }
    }

    const event = body.event;
    const data = body.data || {};

    // Aqui você pode automatizar ações ao confirmar o pagamento, por exemplo:
    //  - registrar o pedido em um banco de dados
    //  - disparar o e-mail com o atestado
    // Como o site é estático, a confirmação ao usuário é feita por polling (/api/status).
    switch (event) {
      case 'charge.paid':
        // pagamento confirmado: data.transaction_id, data.external_id, data.amount...
        break;
      case 'charge.failed':
      case 'charge.refunded':
        break;
      default:
        break;
    }

    // Responda sempre 2xx rápido para evitar reenvios (retries).
    res.status(200).json({ received: true });
  } catch (e) {
    // Mesmo em erro, evitamos retries infinitos respondendo 200.
    res.status(200).json({ received: true });
  }
};
