// POST /api/criar-pix
// Cria uma cobrança PIX na MasterPag (PayGateway) do lado do servidor.
// A x-secret-key NUNCA vai para o frontend — fica apenas em variável de ambiente.

const BASE = process.env.MASTERPAG_BASE_URL || 'https://api.masterpag.com/functions/v1';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido. Use POST.' });
    return;
  }

  const PUB = process.env.MASTERPAG_PUBLIC_KEY;
  const SEC = process.env.MASTERPAG_SECRET_KEY;
  if (!PUB || !SEC) {
    res.status(500).json({ error: 'Chaves da MasterPag não configuradas no servidor (MASTERPAG_PUBLIC_KEY / MASTERPAG_SECRET_KEY).' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { amount, nome, email, cpf, telefone, descricao, postbackUrl } = body;

    // Validações básicas
    if (!amount || !nome || !email || !cpf || !telefone) {
      res.status(400).json({ error: 'Dados incompletos: amount, nome, email, cpf e telefone são obrigatórios.' });
      return;
    }
    const cpfDigits = String(cpf).replace(/\D/g, '');
    const telDigits = String(telefone).replace(/\D/g, '');
    const isCnpj = cpfDigits.length > 11;

    // ⚠️ UNIDADE DO VALOR: a doc da MasterPag é ambígua (a tabela diz "centavos",
    // mas o exemplo de código usa reais: amount: 100.00). Estamos enviando em REAIS,
    // seguindo o exemplo. CONFIRME com um pagamento de teste antes de ir ao ar.
    const valor = Number(amount);

    const payload = {
      amount: valor,
      paymentMethod: 'pix',
      customer: {
        name: nome,
        email: email,
        phone: telDigits,
        document: { number: cpfDigits, type: isCnpj ? 'cnpj' : 'cpf' }
      },
      items: [{
        title: descricao || 'Atestado médico online',
        unitPrice: valor,
        quantity: 1,
        tangible: false
      }]
    };
    // Webhook por transação: usa o informado ou monta a partir do domínio atual.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (postbackUrl) {
      payload.postbackUrl = postbackUrl;
    } else if (host) {
      payload.postbackUrl = `https://${host}/api/webhook`;
    }

    const r = await fetch(`${BASE}/pix-receive`, {
      method: 'POST',
      headers: {
        'x-public-key': PUB,
        'x-secret-key': SEC,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      res.status(r.status).json({
        error: (data && data.error && data.error.message) || 'Erro ao criar a cobrança PIX.',
      });
      return;
    }

    // Devolve ao frontend APENAS o necessário (nunca as chaves)
    // Estrutura real da resposta MasterPag:
    // { success, transaction: { id, status, amount, fee_amount, net_amount },
    //   pix: { qrCode, copyPaste, expiresAt, externalId } }
    const transaction = data.transaction || {};
    const pix         = data.pix         || {};

    res.status(200).json({
      id:             transaction.id,
      status:         transaction.status,
      amount:         transaction.amount,
      qrCode:         pix.qrCode    || pix.copyPaste,   // código copia e cola EMV
      qrCodeUrl:      pix.qrCodeUrl || null,             // imagem QR (se disponivel)
      copyPaste:      pix.copyPaste || pix.qrCode,
      expirationDate: pix.expiresAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Falha interna ao gerar a cobrança PIX.' });
  }
};
