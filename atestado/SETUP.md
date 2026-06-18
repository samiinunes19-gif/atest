# MedFácil — Setup & Deploy

Site estático (HTML) + funções serverless (Vercel) para pagamento PIX via **MasterPag (PayGateway)**.

## Estrutura

```
index.html              Landing page
requisicao.html         Funil de solicitação (8 passos)
termos-de-uso.html      Páginas legais
politica-privacidade.html
garantia.html
empresa.html
logo.png / doutor.png   Imagens
api/
  criar-pix.js          POST  /api/criar-pix   → cria cobrança PIX
  status.js             GET   /api/status?id=  → consulta status (polling)
  webhook.js            POST  /api/webhook     → recebe notificações da MasterPag
```

## 1. Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MASTERPAG_PUBLIC_KEY` | Sim | Chave pública (`pk_live_...` ou `pk_test_...`) |
| `MASTERPAG_SECRET_KEY` | Sim | Chave secreta (`sk_live_...` ou `sk_test_...`) — **nunca no frontend** |
| `MASTERPAG_WEBHOOK_SECRET` | Recomendada | Secret para validar a assinatura HMAC do webhook |

> Pegue as chaves em **MasterPag → Configurações → Chaves API**.
> Comece com `pk_test_` / `sk_test_` para validar; só depois troque por `live`.

## 2. Deploy na Vercel

1. Conecte o repositório do GitHub na Vercel (New Project → Import).
2. Framework Preset: **Other** (é site estático + funções `/api`). Sem build command.
3. Adicione as variáveis de ambiente acima.
4. Deploy. As funções em `/api/*.js` viram endpoints automaticamente.

> Não precisa subir `server.ps1` (é só para o preview local) nem `node_modules`.

## 3. Fluxo de pagamento

1. No passo de pagamento, o frontend chama `POST /api/criar-pix` com os dados do cliente e o valor.
2. O backend cria a cobrança na MasterPag (com a secret) e devolve o **QR Code** e o **copia e cola**.
3. O frontend exibe o QR e faz **polling** em `GET /api/status?id=...` a cada 5s.
4. Quando o status vira `paid`, a tela de sucesso aparece automaticamente.
5. A MasterPag também chama `POST /api/webhook` (registrado automaticamente por transação).

## ⚠️ ATENÇÃO antes de ir ao ar

- **Unidade do valor (`amount`)**: a documentação da MasterPag é ambígua — a tabela diz
  "centavos", mas o exemplo de código usa **reais** (`amount: 100.00`). O código está
  enviando em **REAIS**. **Faça um pagamento de teste de R$ 1,00** e confira no painel se
  o valor bateu. Se vier 100x maior/menor, ajuste em `api/criar-pix.js` (a linha `const valor`).
- **Assinatura do webhook**: validamos com `JSON.stringify(body)`. Se as assinaturas
  falharem de forma consistente, pode ser preciso validar sobre o corpo bruto (raw body).
- Teste todo o fluxo em ambiente de **teste** (`pk_test_`/`sk_test_`) antes do `live`.

## 4. Rodar localmente (preview)

O preview local (`server.ps1`) serve só os arquivos estáticos — **não executa `/api`**.
Nesse caso o site faz *fallback* automático para o QR placeholder, sem quebrar.
Para testar as funções localmente de verdade, use a CLI da Vercel: `vercel dev`.
