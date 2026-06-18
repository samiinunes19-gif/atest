// GET /api/status?id=<transaction_id>
// Consulta o status de uma cobrança PIX na MasterPag (usado como polling no frontend).

const BASE = process.env.MASTERPAG_BASE_URL || 'https://api.masterpag.com/functions/v1';

module.exports = async function handler(req, res) {
  const PUB = process.env.MASTERPAG_PUBLIC_KEY;
  const SEC = process.env.MASTERPAG_SECRET_KEY;
  if (!PUB || !SEC) {
    res.status(500).json({ error: 'Chaves da MasterPag não configuradas no servidor.' });
    return;
  }

  const id = req.query.id || req.query.transaction_id;
  if (!id) {
    res.status(400).json({ error: 'Parâmetro id (transaction_id) é obrigatório.' });
    return;
  }

  try {
    const r = await fetch(`${BASE}/pix-receive?transaction_id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { 'x-public-key': PUB, 'x-secret-key': SEC }
    });
    const data = await r.json().catch(() => ({}));
    // Estrutura real: { success, transaction: { id, status, amount, ... } }
    const t = data.transaction || data || {};
    res.status(r.ok ? 200 : r.status).json({
      status: t.status || 'unknown',
      paidAt: t.paid_at || t.paidAt || null,
      amount: t.amount || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao consultar o status da transação.' });
  }
};
