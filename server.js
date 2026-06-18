/**
 * ============================================================
 * SISTEMA DE PROTEÇÃO - SERVER.JS
 * Servidor Express com filtros de IP, User-Agent, Cookie e Geo
 * ============================================================
 */

'use strict';

// Carrega variáveis do .env antes de tudo
require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const geoip        = require('geoip-lite');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const crypto       = require('crypto');
const { Pool }     = require('pg');
const { put }      = require('@vercel/blob');

// ============================================================
// ⚙️  CONFIGURAÇÕES AJUSTÁVEIS
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';  // Senha do painel
const PORT           = process.env.PORT           || 3000;         // Porta do servidor
const AUTH_PARAM     = process.env.AUTH_PARAM     || 'ads';        // Parâmetro da URL para autorização (campanha)
const AUTH_VALUE     = process.env.AUTH_VALUE     || 'go';         // Valor do parâmetro de autorização
const COOKIE_NAME    = process.env.COOKIE_NAME    || '_site_acc';  // Nome do cookie de acesso
const COOKIE_DAYS    = parseInt(process.env.COOKIE_DAYS) || 7;     // Validade do cookie em dias
const LOG_FLUSH_MS   = 30_000;  // Flush do log na memória a cada 30s
const SSE_DEBOUNCE   = 1_000;   // Debounce de SSE em ms (1s)

// Pasta raiz do conteúdo real (funil do atestado)
// Altere este caminho se mover os arquivos do funil
const CONTENT_DIR    = path.join(__dirname, 'atestado');

// ============================================================
// 📊 CONEXÃO POSTGRES (Vercel Postgres / Neon)
// ============================================================
let pool = null;
const dbUrl = process.env.POSTGRES_URL || process.env.STORAGE_URL;
if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

// Inicializa tabelas
async function initDatabase() {
  if (!pool) {
    console.warn('⚠️ [DB] Banco de dados não conectado (POSTGRES_URL/STORAGE_URL ausente). Armazenamento local ativo.');
    return;
  }
  try {
    const client = await pool.connect();
    
    // Tabela de Logs de Acesso
    await client.query(`
      CREATE TABLE IF NOT EXISTS acessos (
        id VARCHAR(50) PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        ip VARCHAR(45) NOT NULL,
        pais VARCHAR(10) NOT NULL,
        cookie BOOLEAN NOT NULL,
        resultado VARCHAR(20) NOT NULL,
        motivo VARCHAR(50),
        ua TEXT,
        path VARCHAR(255)
      )
    `);

    // Tabela de Transações PIX
    await client.query(`
      CREATE TABLE IF NOT EXISTS transacoes (
        id VARCHAR(100) PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        cpf VARCHAR(20) NOT NULL,
        telefone VARCHAR(20) NOT NULL,
        valor NUMERIC(10, 2) NOT NULL,
        descricao VARCHAR(255),
        comprovante_url TEXT,
        comprovante_nome VARCHAR(255),
        status VARCHAR(50) NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL
      )
    `);

    client.release();
    console.log('✅ [DB] Tabelas verificadas/criadas no Postgres com sucesso.');
  } catch (err) {
    console.error('❌ [DB] Erro ao inicializar banco de dados:', err.message);
  }
}

// ============================================================
// 📁 CONFIGURAÇÃO DE UPLOADS DE COMPROVANTES (Vercel Blob / Local)
// ============================================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
// Só cria a pasta local se não estiver na Vercel (filesystem somente leitura)
if (!process.env.VERCEL && !fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const useVercelBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

const storage = useVercelBlob
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
      filename:    (_req, file, cb) => {
        const ts  = Date.now();
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, `comp_${ts}${ext}`);
      },
    });

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ============================================================
// 🧾 ARMAZENAMENTO DE TRANSAÇÕES PIX EM MEMÓRIA (Fallback)
// ============================================================
const transacoesMap = new Map();

async function salvarTransacao(id, dados) {
  const existente = transacoesMap.get(id) || {};
  const mesclado = { ...existente, ...dados, atualizadoEm: new Date().toISOString() };
  transacoesMap.set(id, mesclado);

  if (pool) {
    try {
      const criadoEm = mesclado.criadoEm || new Date().toISOString();
      const status = mesclado.status || 'pago_com_comprovante';
      const comprovanteUrl = mesclado.comprovante ? mesclado.comprovante.url : null;
      const comprovanteNome = mesclado.comprovante ? (mesclado.comprovante.original || mesclado.comprovante.arquivo) : null;

      await pool.query(
        `INSERT INTO transacoes (id, nome, email, cpf, telefone, valor, descricao, comprovante_url, comprovante_nome, status, criado_em, atualizado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           nome = EXCLUDED.nome,
           email = EXCLUDED.email,
           cpf = EXCLUDED.cpf,
           telefone = EXCLUDED.telefone,
           valor = EXCLUDED.valor,
           descricao = EXCLUDED.descricao,
           comprovante_url = EXCLUDED.comprovante_url,
           comprovante_nome = EXCLUDED.comprovante_nome,
           status = EXCLUDED.status,
           atualizado_em = EXCLUDED.atualizado_em`,
        [
          id,
          mesclado.nome || '—',
          mesclado.email || '—',
          mesclado.cpf || '—',
          mesclado.telefone || '—',
          mesclado.valor || 0,
          mesclado.descricao || 'Atestado médico online',
          comprovanteUrl,
          comprovanteNome,
          status,
          criadoEm,
          mesclado.atualizadoEm
        ]
      );
    } catch (err) {
      console.error('[DB] Erro ao salvar transação no banco:', err.message);
    }
  }
}

// ============================================================
// 🚫 LISTA DE SUB-REDES BLOQUEADAS
// Inclui Google, AWS, Azure, GCP, Cloudflare, indexadores, etc.
// ============================================================
const BLOCKED_SUBNETS = [
  // Google Crawlers / APIs / Cloud
  '66.249.64.0/19',
  '66.249.92.0/22',
  '72.14.192.0/18',
  '74.125.0.0/16',
  '104.132.0.0/10',
  '108.177.0.0/17',
  '130.211.0.0/22',
  '142.250.0.0/15',
  '172.217.0.0/16',
  '172.253.0.0/16',
  '173.194.0.0/16',
  '192.178.0.0/16',
  '209.85.128.0/17',
  '216.58.192.0/19',
  '216.239.32.0/19',

  // Google Cloud Platform
  '34.0.0.0/8',
  '35.0.0.0/8',

  // Amazon AWS
  '52.0.0.0/8',
  '54.0.0.0/8',
  '3.0.0.0/8',
  '18.0.0.0/8',
  '13.0.0.0/8',

  // Microsoft Azure
  '13.64.0.0/11',
  '20.0.0.0/8',
  '40.64.0.0/10',
  '104.0.0.0/8',

  // Cloudflare
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',

  // Bing / Microsoft
  '40.77.0.0/17',
  '157.55.0.0/16',
  '207.46.0.0/16',

  // Outros indexadores e serviços específicos
  '162.120.128.0/17',
  '193.186.4.0/24',
  '74.114.28.0/22',

  // Digital Ocean
  '64.225.0.0/16',
  '104.248.0.0/16',
  '134.122.0.0/15',
  '138.197.0.0/16',
  '159.65.0.0/16',
  '161.35.0.0/16',
  '167.71.0.0/16',
  '165.22.0.0/15',

  // Linode / Akamai
  '45.33.0.0/17',
  '45.56.0.0/21',
  '50.116.0.0/16',
  '69.164.192.0/20',
  '72.14.176.0/21',
  '96.126.96.0/20',

  // OVH / SYS
  '51.68.0.0/16',
  '51.75.0.0/16',
  '51.91.0.0/16',
  '54.36.0.0/14',
  '91.121.0.0/16',
  '135.125.0.0/16',
  '145.239.0.0/16',
  '146.59.0.0/16',
  '188.165.0.0/16',
  '193.70.0.0/16',

  // Vultr
  '45.32.0.0/16',
  '45.63.0.0/16',
  '66.42.0.0/16',
  '108.61.0.0/16',
  '144.202.0.0/16',
  '155.138.0.0/16',
  '207.246.0.0/16',
];

// ============================================================
// 🔧 CONVERSÃO DE SUB-REDES PARA VERIFICAÇÃO EFICIENTE
// ============================================================

/**
 * Converte um endereço IPv4 em formato decimal (32 bits)
 * @param {string} ip - Endereço IP em notação decimal pontilhada
 * @returns {number} Representação numérica do IP
 */
function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Pré-compila as sub-redes bloqueadas em ranges numéricos para performance
 * @returns {Array<{start: number, end: number, cidr: string}>}
 */
function compileSubnets(subnets) {
  return subnets.map(cidr => {
    const [network, bits] = cidr.split('/');
    const mask    = bits ? (0xFFFFFFFF << (32 - parseInt(bits))) >>> 0 : 0xFFFFFFFF;
    const start   = (ipToLong(network) & mask) >>> 0;
    const end     = (start | (~mask >>> 0)) >>> 0;
    return { start, end, cidr };
  });
}

const BLOCKED_RANGES = compileSubnets(BLOCKED_SUBNETS);

/**
 * Verifica se um IP está em alguma sub-rede bloqueada
 * @param {string} ip - IP a verificar
 * @returns {string|null} - CIDR bloqueado ou null
 */
function isIpBlocked(ip) {
  // Ignora IPv6 puro, localhost e IPs privados
  if (!ip || ip === '::1' || ip === '127.0.0.1') return null;

  // Extrai IPv4 de formato IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  // Verifica se é um IPv4 válido
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp)) return null;

  const numeric = ipToLong(cleanIp);
  for (const range of BLOCKED_RANGES) {
    if (numeric >= range.start && numeric <= range.end) {
      return range.cidr;
    }
  }
  return null;
}

// ============================================================
// 🤖 PADRÕES DE USER-AGENT BLOQUEADOS
// ============================================================
const BLOCKED_UA_PATTERNS = [
  /headlesschrome/i,
  /phantomjs/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /python-requests/i,
  /python-urllib/i,
  /python\/\d/i,
  /scrapy/i,
  /http\.client/i,
  /java\/\d/i,
  /go-http-client/i,
  /okhttp/i,
  /libwww-perl/i,
  /lwp-trivial/i,
  /mechanize/i,
  /nutch/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /dotbot/i,
  /mj12bot/i,
  /blexbot/i,
  /petalbot/i,
  /bytespider/i,
  /baiduspider/i,
  /yandexbot/i,
  /sogou/i,
  /exabot/i,
  /facebot/i,
  /ia_archiver/i,
  /archive\.org_bot/i,
  /zgrab/i,
  /masscan/i,
  /nmap/i,
  /nikto/i,
  /sqlmap/i,
  /havij/i,
  /dirbuster/i,
  /axios\/\d/i,
  /node-fetch/i,
  /got\/\d/i,
  /node\.js/i,
  /httpclient/i,
  /apache-httpclient/i,
  /httpunit/i,
  /twiceler/i,
  /voila/i,
  /grapeshot/i,
];

/**
 * Verifica se o User-Agent é de um bot/scraper bloqueado
 * @param {string} ua - String do User-Agent
 * @returns {string|null} - Padrão bloqueado ou null
 */
function isUaBlocked(ua) {
  if (!ua) return 'user_agent_vazio';
  for (const pattern of BLOCKED_UA_PATTERNS) {
    if (pattern.test(ua)) return pattern.toString();
  }
  return null;
}

// ============================================================
// 📊 SISTEMA DE LOG EM MEMÓRIA
// ============================================================
const MAX_LOG_ENTRIES = 1000; // Máximo de entradas mantidas em memória

/** @type {Array<Object>} */
let accessLog = [];

/**
 * Registra um acesso no log
 * @param {object} entry - Dados do acesso
 */
function logAccess(entry) {
  const record = {
    id:        Date.now() + Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  // Notifica clientes SSE
  scheduleSSEBroadcast(record);

  if (pool) {
    pool.query(
      `INSERT INTO acessos (id, timestamp, ip, pais, cookie, resultado, motivo, ua, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.timestamp,
        record.ip || '0.0.0.0',
        record.pais || 'unknown',
        record.cookie || false,
        record.resultado,
        record.motivo || null,
        record.ua || null,
        record.path || null
      ]
    ).catch(err => console.error('[DB] Erro ao registrar log de acesso:', err.message));
  } else {
    accessLog.push(record);
    if (accessLog.length > MAX_LOG_ENTRIES) {
      accessLog = accessLog.slice(-MAX_LOG_ENTRIES);
    }
  }
}

// Flush periódico (usado apenas para logs em memória, se ativo)
setInterval(() => {
  if (pool) return; // Se usa Postgres, o DB gerencia o histórico
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
  const before = accessLog.length;
  accessLog = accessLog.filter(e => new Date(e.timestamp).getTime() > cutoff);
  if (accessLog.length < before) {
    console.log(`[LOG FLUSH] Removidas ${before - accessLog.length} entradas antigas. Total: ${accessLog.length}`);
  }
}, LOG_FLUSH_MS);

// ============================================================
// 📡 SERVER-SENT EVENTS (SSE) COM DEBOUNCE
// ============================================================

/** @type {Set<import('express').Response>} */
const sseClients = new Set();
let sseDebounceTimer = null;
let sseQueue = [];

/**
 * Envia evento SSE para todos os clientes conectados
 * @param {string} event - Nome do evento
 * @param {*} data - Dados a enviar (serão JSON.stringify'd)
 */
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Agenda broadcast SSE com debounce para evitar flood
 * @param {object} record - Entrada de log
 */
function scheduleSSEBroadcast(record) {
  sseQueue.push(record);
  if (sseDebounceTimer) return;
  sseDebounceTimer = setTimeout(() => {
    broadcastSSE('log', sseQueue);
    sseQueue = [];
    sseDebounceTimer = null;
  }, SSE_DEBOUNCE);
}

// ============================================================
// 🛡️  MIDDLEWARE PRINCIPAL DE PROTEÇÃO
// ============================================================

/**
 * Extrai o IP real do visitante levando em conta proxies
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRealIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

/**
 * Identifica o país do IP usando geoip-lite
 * @param {string} ip
 * @returns {string} Código do país ou 'unknown'
 */
function getCountry(ip) {
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // Loopback e IPs privados
  if (cleanIp === '127.0.0.1' || cleanIp === '::1') return 'loopback';
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(cleanIp)) return 'private';

  const geo = geoip.lookup(cleanIp);
  return geo?.country || 'unknown';
}

/**
 * Define headers anti-cache em todas as respostas
 * @param {import('express').Response} res
 */
function setNoCacheHeaders(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma':        'no-cache',
    'Expires':       '0',
    'Surrogate-Control': 'no-store',
  });
}

// ============================================================
// 🚀 CONFIGURAÇÃO DO SERVIDOR EXPRESS
// ============================================================
const app = express();

app.set('trust proxy', true); // Necessário para X-Forwarded-For atrás de proxy/nginx

app.use(cookieParser());
app.use(cors({
  origin: false, // Desabilita CORS para proteção
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// 🔑 ROTA DE AUTORIZAÇÃO (concessão de cookie)
// ============================================================
/**
 * Quando o visitante acessa qualquer URL com ?auth=go,
 * o servidor define o cookie de acesso e redireciona para a URL limpa.
 * Exemplo: /index.html?auth=go → define cookie → redireciona para /index.html
 */
app.use((req, res, next) => {
  if (req.query[AUTH_PARAM] === AUTH_VALUE) {
    const cookieOptions = {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   COOKIE_DAYS * 24 * 60 * 60 * 1000, // dias em ms
      sameSite: 'strict',
    };
    res.cookie(COOKIE_NAME, 'true', cookieOptions);

    // Remove o parâmetro de auth da URL e redireciona
    const cleanUrl = req.path + (
      Object.keys(req.query).filter(k => k !== AUTH_PARAM).length
        ? '?' + new URLSearchParams(
            Object.fromEntries(
              Object.entries(req.query).filter(([k]) => k !== AUTH_PARAM)
            )
          ).toString()
        : ''
    );

    logAccess({
      ip:      getRealIp(req),
      pais:    getCountry(getRealIp(req)),
      cookie:  false,
      resultado: 'cookie_concedido',
      motivo:  'url_autorizacao',
      ua:      req.headers['user-agent'] || '',
      path:    req.path,
    });

    return res.redirect(302, cleanUrl);
  }
  next();
});

// ============================================================
// 🔑 AUXILIAR: AUTENTICAÇÃO DO PAINEL ADMIN
// ============================================================
function checkAdminAuth(req) {
  // 1. Verifica Header de Autorização (Basic Auth) para retrocompatibilidade
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const [, encoded] = authHeader.split(' ');
    if (encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString().split(':');
      const pass    = decoded[1];
      if (pass === ADMIN_PASSWORD) {
        return true;
      }
    }
  }

  // 2. Verifica Cookie de Sessão
  const expectedHash = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  if (req.cookies && req.cookies['admin_session'] === expectedHash) {
    return true;
  }

  return false;
}

// POST /admin/api/login — realiza a autenticação por senha
app.post('/admin/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const sessionVal = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
    res.cookie('admin_session', sessionVal, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 dias
      sameSite: 'strict',
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Senha incorreta. Tente novamente.' });
});

// ============================================================
// 📡 ROTA SSE – streaming de logs para o painel
// ============================================================
app.get('/admin/stream', (req, res) => {
  if (!checkAdminAuth(req)) {
    return res.status(401).send('Não autorizado');
  }

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // Desabilita buffering no nginx
  });
  res.flushHeaders();

  // Envia histórico inicial
  if (pool) {
    pool.query('SELECT * FROM acessos ORDER BY timestamp DESC LIMIT 200')
      .then(result => {
        const formattedLogs = result.rows.map(row => ({
          id: row.id,
          timestamp: row.timestamp.toISOString(),
          ip: row.ip,
          pais: row.pais,
          cookie: row.cookie,
          resultado: row.resultado,
          motivo: row.motivo,
          ua: row.ua,
          path: row.path
        })).reverse();
        res.write(`event: history\ndata: ${JSON.stringify(formattedLogs)}\n\n`);
      })
      .catch(err => {
        console.error('[DB] Erro ao ler histórico de logs:', err.message);
        res.write(`event: history\ndata: ${JSON.stringify(accessLog.slice(-200))}\n\n`);
      });
  } else {
    res.write(`event: history\ndata: ${JSON.stringify(accessLog.slice(-200))}\n\n`);
  }

  sseClients.add(res);

  // Heartbeat a cada 15s para manter conexão
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* cliente desconectou */ }
  }, 15_000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// ============================================================
// 💳 ROTAS DA API DE PAGAMENTO PIX (MasterPag)
// Registradas ANTES do middleware de proteção para que o
// frontend autenticado possa chamá-las sem bloqueio de cookie.
// As chaves NUNCA chegam ao navegador — ficam só no servidor.
// ============================================================
const criarPixHandler = require('./atestado/api/criar-pix');
const statusHandler   = require('./atestado/api/status');
const webhookHandler  = require('./atestado/api/webhook');

// POST /api/criar-pix — gera cobrança PIX na MasterPag
app.post('/api/criar-pix', (req, res) => criarPixHandler(req, res));

// GET  /api/status?id=xxx — consulta status do pagamento (polling)
app.get('/api/status',     (req, res) => statusHandler(req, res));

// POST /api/webhook — recebe notificações de pagamento confirmado da MasterPag
app.post('/api/webhook',   (req, res) => webhookHandler(req, res));

// ============================================================
// 🧾 ROTA: SALVAR COMPROVANTE + DADOS DA TRANSAÇÃO
// Chamada pelo frontend após o pagamento ser confirmado e o
// usuário anexar o comprovante. Armazena tudo no servidor.
// ============================================================
app.post('/api/salvar-comprovante', upload.single('comprovante'), async (req, res) => {
  try {
    const { transacaoId, nome, email, cpf, telefone, valor, descricao } = req.body || {};

    if (!transacaoId) {
      return res.status(400).json({ error: 'transacaoId é obrigatório.' });
    }

    let comprovante = null;

    if (req.file) {
      if (useVercelBlob) {
        // Envia para o Vercel Blob
        const blob = await put(`comprovantes/${Date.now()}_${req.file.originalname}`, req.file.buffer, {
          access: 'public',
        });
        comprovante = {
          arquivo:   blob.pathname,
          tamanho:   req.file.size,
          tipo:      req.file.mimetype,
          original:  req.file.originalname,
          url:       blob.url,
        };
      } else {
        // Envio local em disco
        comprovante = {
          arquivo:   req.file.filename,
          tamanho:   req.file.size,
          tipo:      req.file.mimetype,
          original:  req.file.originalname,
          url:       `/admin/uploads/${req.file.filename}`,
        };
      }
    }

    await salvarTransacao(transacaoId, {
      id:          transacaoId,
      nome:        nome         || '—',
      email:       email        || '—',
      cpf:         cpf          || '—',
      telefone:    telefone     || '—',
      valor:       parseFloat(valor) || 0,
      descricao:   descricao    || 'Atestado médico online',
      comprovante,
      status:      'pago_com_comprovante',
      criadoEm:    new Date().toISOString(),
    });

    console.log(`[PIX] Comprovante salvo para transação ${transacaoId} — ${nome} (${email})`);
    res.json({ ok: true, comprovante: comprovante?.url || null });
  } catch (e) {
    console.error('[PIX] Erro ao salvar comprovante:', e.message);
    res.status(500).json({ error: 'Erro interno ao salvar comprovante.' });
  }
});

// ============================================================
// 🛡️  ROTA DO PAINEL ADMINISTRATIVO (/admin)
// ============================================================
app.get('/admin', (req, res) => {
  if (!checkAdminAuth(req)) {
    setNoCacheHeaders(res);
    return res.sendFile(path.join(__dirname, 'admin-login.html'));
  }

  setNoCacheHeaders(res);
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Servir arquivos estáticos do painel (CSS, JS) com autenticação
app.get(['/admin.js', '/admin.css'], (req, res) => {
  if (!checkAdminAuth(req)) {
    return res.status(401).send('Não autorizado');
  }
  res.sendFile(path.join(__dirname, req.path.slice(1)));
});

// ============================================================
// 📊 API REST – dados para o painel
// ============================================================
app.get('/admin/api/logs', (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Não autorizado' });

  const limit  = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;

  if (pool) {
    Promise.all([
      pool.query('SELECT COUNT(*) FROM acessos'),
      pool.query("SELECT COUNT(*) FROM acessos WHERE resultado = 'bloqueado'"),
      pool.query("SELECT COUNT(*) FROM acessos WHERE resultado = 'autorizado'"),
      pool.query('SELECT * FROM acessos ORDER BY timestamp DESC LIMIT $1 OFFSET $2', [limit, offset])
    ]).then(([totalRes, blRes, authRes, logsRes]) => {
      res.json({
        total: parseInt(totalRes.rows[0].count),
        bloqueado: parseInt(blRes.rows[0].count),
        autorizado: parseInt(authRes.rows[0].count),
        logs: logsRes.rows.map(row => ({
          id: row.id,
          timestamp: row.timestamp.toISOString(),
          ip: row.ip,
          pais: row.pais,
          cookie: row.cookie,
          resultado: row.resultado,
          motivo: row.motivo,
          ua: row.ua,
          path: row.path
        }))
      });
    }).catch(err => {
      res.status(500).json({ error: 'Erro ao consultar logs no banco de dados.' });
    });
  } else {
    const logs = accessLog.slice(-(limit + offset)).slice(0, limit);
    res.json({
      total:     accessLog.length,
      bloqueado: accessLog.filter(e => e.resultado === 'bloqueado').length,
      autorizado: accessLog.filter(e => e.resultado === 'autorizado').length,
      logs:      logs.reverse(),
    });
  }
});

// GET /admin/api/transacoes — lista todas as transações PIX com comprovantes
app.get('/admin/api/transacoes', (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).json({ error: 'Não autorizado' });

  if (pool) {
    pool.query('SELECT * FROM transacoes ORDER BY criado_em DESC')
      .then(result => {
        const lista = result.rows.map(row => ({
          id: row.id,
          nome: row.nome,
          email: row.email,
          cpf: row.cpf,
          telefone: row.telefone,
          valor: parseFloat(row.valor),
          descricao: row.descricao,
          status: row.status,
          criadoEm: row.criado_em.toISOString(),
          atualizadoEm: row.atualizado_em.toISOString(),
          comprovante: row.comprovante_url ? {
            url: row.comprovante_url,
            original: row.comprovante_nome,
            arquivo: row.comprovante_nome,
            tipo: row.comprovante_url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
          } : null
        }));
        res.json({ total: lista.length, transacoes: lista });
      })
      .catch(err => {
        res.status(500).json({ error: 'Erro ao listar transações no banco de dados.' });
      });
  } else {
    const lista = Array.from(transacoesMap.values())
      .sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
    res.json({ total: lista.length, transacoes: lista });
  }
});

// GET /admin/uploads/:filename — serve o arquivo de comprovante (só admin)
app.get('/admin/uploads/:filename', (req, res) => {
  if (!checkAdminAuth(req)) return res.status(401).send('Não autorizado');

  const filename = path.basename(req.params.filename); // evita path traversal
  const filepath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Arquivo não encontrado');
  res.sendFile(filepath);
});

// ============================================================
// 🛡️  MIDDLEWARE DE PROTEÇÃO PRINCIPAL (aplicado a TODAS as rotas de conteúdo)
// ============================================================
app.use((req, res, next) => {
  // Rotas do painel admin já foram tratadas acima
  if (req.path.startsWith('/admin')) return next();

  setNoCacheHeaders(res);

  const ip     = getRealIp(req);
  const ua     = req.headers['user-agent'] || '';
  const cookie = req.cookies[COOKIE_NAME] === 'true';
  const pais   = getCountry(ip);

  // ---------------------------------------------------------
  // FLUXO DE DECISÃO (comentado passo a passo):
  // ---------------------------------------------------------

  // PASSO 1: Verifica se o IP está em alguma faixa bloqueada
  const ipBloqueadoCidr = isIpBlocked(ip);
  if (ipBloqueadoCidr) {
    logAccess({ ip, pais, cookie, resultado: 'bloqueado', motivo: 'ip_bloqueado', ua, path: req.path, detalhe: ipBloqueadoCidr });
    return res.sendFile(path.join(__dirname, 'white-page.html'));
  }

  // PASSO 2: Verifica se o User-Agent é de um bot/ferramenta bloqueada
  const uaBloqueadoPattern = isUaBlocked(ua);
  if (uaBloqueadoPattern) {
    logAccess({ ip, pais, cookie, resultado: 'bloqueado', motivo: 'user_agent_restrito', ua, path: req.path, detalhe: uaBloqueadoPattern });
    return res.sendFile(path.join(__dirname, 'white-page.html'));
  }

  // PASSO 3: Verifica presença do cookie de autorização
  if (!cookie) {
    logAccess({ ip, pais, cookie, resultado: 'bloqueado', motivo: 'sem_cookie', ua, path: req.path });
    return res.sendFile(path.join(__dirname, 'white-page.html'));
  }

  // PASSO 4: Verifica o país do visitante (apenas BR, loopback e private passam)
  const paisesPermitidos = ['BR', 'loopback', 'private', 'unknown'];
  if (!paisesPermitidos.includes(pais)) {
    logAccess({ ip, pais, cookie, resultado: 'bloqueado', motivo: 'pais_nao_permitido', ua, path: req.path });
    return res.sendFile(path.join(__dirname, 'white-page.html'));
  }

  // ✅ PASSO 5: Todos os filtros passaram – autorizado!
  logAccess({ ip, pais, cookie, resultado: 'autorizado', motivo: null, ua, path: req.path });
  next();
});

// ============================================================
// 📁 SERVIR ARQUIVOS ESTÁTICOS AUTORIZADOS
// ============================================================
// tracker.js é público (não precisa de cookie) para que o script
// seja carregável pelas páginas – mas só envia dados, não expõe conteúdo
app.get('/tracker.js', (req, res) => {
  setNoCacheHeaders(res);
  res.sendFile(path.join(__dirname, 'tracker.js'));
});

// Serve os arquivos do funil (CONTENT_DIR) após todos os filtros de proteção
// Qualquer arquivo de atestado/ será acessível: index.html, requisicao.html, imagens, etc.
app.use(express.static(CONTENT_DIR, {
  index: 'index.html',
  etag:  false,
  lastModified: false,
}));

// ============================================================
// ❌ TRATAMENTO DE 404
// ============================================================
app.use((req, res) => {
  setNoCacheHeaders(res);
  res.status(404).sendFile(path.join(__dirname, 'white-page.html'));
});

// ============================================================
// 🚀 INICIALIZAÇÃO
// ============================================================
// Inicializa o banco de dados (sem bloquear o export)
initDatabase().catch(err => console.error('❌ [DB] Falha ao inicializar:', err.message));

// Vercel: exporta o app como handler serverless
// Local: sobe o servidor normalmente
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`🛡️  Sistema de proteção ativo`);
    console.log(`🔑  Para autorizar: http://localhost:${PORT}/index.html?${AUTH_PARAM}=${AUTH_VALUE}`);
    console.log(`📊  Painel admin: http://localhost:${PORT}/admin`);
    console.log(`    (Usuário: admin | Senha: ${ADMIN_PASSWORD})`);
  });
}
