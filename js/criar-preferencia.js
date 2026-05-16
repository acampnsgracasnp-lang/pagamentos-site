/* ============================================================
   /api/criar-preferencia.js
   ------------------------------------------------------------
   Vercel Function (Node.js runtime).

   Cria uma preferência de pagamento no Mercado Pago e retorna
   o init_point para o frontend redirecionar o usuário.

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS (Vercel → Settings → Environment Variables):
     - MERCADO_PAGO_ACCESS_TOKEN   (Access Token de Produção do MP)
     - PUBLIC_SITE_URL             (URL pública do frontend — ex.: https://seu-site.github.io/pagamentos-site)
     - API_BASE_URL                (URL do backend — ex.: https://seu-projeto.vercel.app)

   OPCIONAL:
     - MERCADO_PAGO_NOTIFICATION_URL  (sobrescreve a URL do webhook)

   BODY ESPERADO (POST JSON):
     {
       "eventId":        "string",
       "registrationId": "string",
       "quantidade":     1,
       "valorTotal":     120,
       "titulo":         "string",
       "descricao":      "string",
       "payer":          { "name": "...", "phone": "..." }
     }

   RETORNO:
     { id, init_point, sandbox_init_point }
   ============================================================ */

module.exports = async function handler(req, res) {
  // CORS — libera chamadas do frontend (GitHub Pages, etc.)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const ACCESS_TOKEN = (process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
  if (!ACCESS_TOKEN) {
    // Diagnóstico: lista NOMES (sem valores) de envs relacionadas para identificar
    // typos, espaços ou ambiente errado na Vercel.
    const mpVarNames = Object.keys(process.env)
      .filter((k) => /MERCADO|MP_|PAGO|ACCESS_TOKEN/i.test(k))
      .sort();
    console.error("[criar-preferencia] MERCADO_PAGO_ACCESS_TOKEN ausente.", {
      mpVarNames,
      vercelEnv: process.env.VERCEL_ENV,
      region: process.env.VERCEL_REGION
    });
    res.status(500).json({
      error: "MERCADO_PAGO_ACCESS_TOKEN não configurado nas variáveis de ambiente da Vercel.",
      diag: {
        mpVarNames,
        vercelEnv: process.env.VERCEL_ENV || null
      }
    });
    return;
  }

  // Vercel já parseia JSON automaticamente quando Content-Type: application/json
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    eventId,
    registrationId,
    quantidade,
    valorTotal,
    titulo,
    descricao,
    payer
  } = body;

  // VALIDAÇÕES
  if (!eventId || typeof eventId !== "string") {
    res.status(400).json({ error: "eventId é obrigatório." });
    return;
  }
  if (!registrationId || typeof registrationId !== "string") {
    res.status(400).json({ error: "registrationId é obrigatório." });
    return;
  }
  const qtd = Number(quantidade);
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 100) {
    res.status(400).json({ error: "quantidade inválida." });
    return;
  }
  const valor = Number(valorTotal);
  if (!isFinite(valor) || valor <= 0 || valor > 1000000) {
    res.status(400).json({ error: "valorTotal inválido." });
    return;
  }

  // URLs de retorno e notificação
  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const API_BASE_URL = (process.env.API_BASE_URL || "").replace(/\/$/, "");

  if (!PUBLIC_SITE_URL) {
    res.status(500).json({ error: "PUBLIC_SITE_URL não configurado." });
    return;
  }

  const notificationUrl =
    process.env.MERCADO_PAGO_NOTIFICATION_URL ||
    (API_BASE_URL ? `${API_BASE_URL}/api/webhook-mercadopago` : "");

  // Monta o body da preferência (Checkout Pro)
  const tituloFinal = (titulo && String(titulo).slice(0, 250)) || "Inscrição em evento";
  const descricaoFinal = (descricao && String(descricao).slice(0, 600)) || `${qtd} inscrição(ões)`;

  // Para evitar problemas de arredondamento, usamos 1 item com qty=1 e
  // unit_price = valorTotal. (O detalhamento de qty já está na inscrição.)
  const preferenceBody = {
    items: [
      {
        id: registrationId,
        title: tituloFinal,
        description: descricaoFinal,
        category_id: "tickets",
        quantity: 1,
        currency_id: "BRL",
        unit_price: Math.round(valor * 100) / 100
      }
    ],
    external_reference: registrationId,
    metadata: {
      eventId: eventId,
      registrationId: registrationId,
      quantidade: qtd
    },
    back_urls: {
      success: `${PUBLIC_SITE_URL}/sucesso?registrationId=${encodeURIComponent(registrationId)}`,
      pending: `${PUBLIC_SITE_URL}/pendente?registrationId=${encodeURIComponent(registrationId)}`,
      failure: `${PUBLIC_SITE_URL}/erro?registrationId=${encodeURIComponent(registrationId)}`
    },
    auto_return: "approved",
    statement_descriptor: "EVENTO",
    payment_methods: {
      // Checkout Pro: PIX + crédito + débito.
      // Bloqueia boleto/caixa (sem confirmação automática útil aqui).
      excluded_payment_types: [{ id: "atm" }, { id: "ticket" }],
      installments: 12
    }
  };

  if (notificationUrl) {
    preferenceBody.notification_url = notificationUrl;
  }

  if (payer && (payer.name || payer.phone)) {
    preferenceBody.payer = {};
    if (payer.name) {
      const parts = String(payer.name).trim().split(/\s+/);
      preferenceBody.payer.name = parts.shift();
      if (parts.length) preferenceBody.payer.surname = parts.join(" ");
    }
    if (payer.phone) {
      const digits = String(payer.phone).replace(/\D/g, "");
      if (digits.length >= 10) {
        preferenceBody.payer.phone = {
          area_code: digits.slice(0, 2),
          number: digits.slice(2)
        };
      }
    }
  }

  try {
    const mpResp = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        // Idempotência: evita criar 2 preferências iguais se o frontend reenviar
        "X-Idempotency-Key": `${registrationId}-${Date.now()}`
      },
      body: JSON.stringify(preferenceBody)
    });

    const text = await mpResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!mpResp.ok) {
      console.error("Erro MP:", mpResp.status, data);
      res.status(502).json({
        error: "Falha ao criar preferência no Mercado Pago.",
        details: data
      });
      return;
    }

    res.status(200).json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });
  } catch (err) {
    console.error("Exceção criar-preferencia:", err);
    res.status(500).json({ error: "Erro interno.", message: err.message });
  }
};
