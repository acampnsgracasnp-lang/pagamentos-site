/* ============================================================
   /api/criar-preferencia.js
   ------------------------------------------------------------
   Vercel Function (Node.js runtime).

   FLUXO:
     1. Recebe dados completos da inscrição (participantes incluso).
     2. Valida vagas/evento ativo no Firestore (server-side).
     3. Salva os dados em /pending_checkouts (NÃO em /registrations).
     4. Cria a preferência no Mercado Pago usando o id do
        pending_checkout como external_reference.
     5. Retorna init_point para o frontend redirecionar.

   A inscrição definitiva (documento em /registrations) só é criada
   pelo webhook quando o pagamento é confirmado (ou pelo menos quando
   o Mercado Pago envia a primeira notificação para o pedido).

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - PUBLIC_SITE_URL
     - API_BASE_URL
     - FIREBASE_SERVICE_ACCOUNT
     - FIREBASE_PROJECT_ID (opcional)

   OPCIONAL:
     - MERCADO_PAGO_NOTIFICATION_URL
   ============================================================ */

const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT não configurado.");
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT precisa ser JSON válido em uma única linha."); }
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
  });
}

function sanitizeParticipantes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(p => {
    const desejaCamiseta =
      p && p.desejaCamiseta === true ? true :
      p && p.desejaCamiseta === false ? false : null;
    const tamanho = String((p && p.tamanhoCamiseta) || "").trim();
    return {
      nome: String((p && p.nome) || "").trim(),
      email: String((p && p.email) || "").trim(),
      telefone: String((p && p.telefone) || "").trim(),
      cidade: String((p && p.cidade) || "").trim(),
      comunidade: String((p && p.comunidade) || "").trim(),
      pastoral: String((p && p.pastoral) || "").trim(),
      endereco: String((p && p.endereco) || "").trim(),
      desejaCamiseta: desejaCamiseta,
      tamanhoCamiseta: desejaCamiseta === false ? "" : tamanho
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido. Use POST." });
    return;
  }

  const ACCESS_TOKEN = (process.env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
  if (!ACCESS_TOKEN) {
    res.status(500).json({ error: "MERCADO_PAGO_ACCESS_TOKEN não configurado." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    eventId,
    eventSlug,
    eventNome,
    quantidade,
    valorTotal,
    valorUnitario,
    participantes,
    titulo,
    descricao,
    payer
  } = body;

  if (!eventId || typeof eventId !== "string") {
    res.status(400).json({ error: "eventId é obrigatório." });
    return;
  }
  const sanitized = sanitizeParticipantes(participantes);
  if (sanitized.length < 1 || sanitized.length > 100) {
    res.status(400).json({
      error: "Lista de participantes vazia ou inválida.",
      debug: {
        participantesRecebidos: Array.isArray(participantes) ? participantes.length : `tipo=${typeof participantes}`,
        bodyKeys: Object.keys(body)
      }
    });
    return;
  }
  // Quantidade é derivada do array de participantes (fonte da verdade).
  // O campo "quantidade" do body é apenas referência caso o cliente envie.
  const qtd = sanitized.length;
  const qtdEnviada = Number(quantidade);
  if (Number.isInteger(qtdEnviada) && qtdEnviada > 0 && qtdEnviada !== qtd) {
    console.warn("[criar-preferencia] quantidade enviada difere do número de participantes:", { qtdEnviada, qtdReal: qtd });
  }
  const valor = Number(valorTotal);
  if (!isFinite(valor) || valor <= 0 || valor > 1000000) {
    res.status(400).json({ error: "valorTotal inválido." });
    return;
  }
  for (let i = 0; i < sanitized.length; i++) {
    if (!sanitized[i].nome || sanitized[i].nome.length < 3) {
      res.status(400).json({ error: `Participante ${i + 1}: nome inválido.` });
      return;
    }
    const tel = sanitized[i].telefone.replace(/\D/g, "");
    if (tel.length < 10) {
      res.status(400).json({ error: `Participante ${i + 1}: telefone inválido.` });
      return;
    }
  }
  const emailPrincipal = sanitized[0].email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPrincipal)) {
    res.status(400).json({ error: "E-mail do responsável inválido." });
    return;
  }

  let db;
  try {
    initFirebase();
    db = admin.firestore();
  } catch (err) {
    console.error("Firebase init falhou:", err);
    res.status(500).json({ error: "Falha ao inicializar Firebase.", message: err.message });
    return;
  }

  // Validação server-side de evento + vagas
  let evento;
  try {
    const evSnap = await db.collection("events").doc(eventId).get();
    if (!evSnap.exists) {
      res.status(404).json({ error: "Evento não encontrado." });
      return;
    }
    evento = evSnap.data();
  } catch (err) {
    console.error("Erro ao ler evento:", err);
    res.status(500).json({ error: "Erro ao consultar evento.", message: err.message });
    return;
  }

  if (!evento.ativo) {
    res.status(400).json({ error: "Inscrições encerradas para este evento." });
    return;
  }
  const limite = Number(evento.limiteIngressos) || 0;
  const vendidos = Number(evento.ingressosVendidos) || 0;
  const restantes = Math.max(0, limite - vendidos);
  if (limite > 0 && qtd > restantes) {
    res.status(400).json({ error: `Apenas ${restantes} vaga(s) disponível(is).` });
    return;
  }

  // Cria pending_checkout (NÃO é uma inscrição — só dados temporários até o pagamento)
  const checkoutRef = db.collection("pending_checkouts").doc();
  const checkoutId = checkoutRef.id;

  const pendingData = {
    eventId,
    eventSlug: typeof eventSlug === "string" ? eventSlug : (evento.slug || ""),
    eventNome: typeof eventNome === "string" ? eventNome : (evento.nome || ""),
    quantidade: qtd,
    valorTotal: valor,
    valorUnitario: Number(valorUnitario) || (Number(evento.valor) || 0),
    participantes: sanitized,
    status: "aguardando",
    preferenceId: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    await checkoutRef.set(pendingData);
  } catch (err) {
    console.error("Erro ao salvar pending_checkout:", err);
    res.status(500).json({ error: "Falha ao iniciar checkout.", message: err.message });
    return;
  }

  // URLs MP
  const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const API_BASE_URL = (process.env.API_BASE_URL || "").replace(/\/$/, "");
  if (!PUBLIC_SITE_URL) {
    await checkoutRef.delete().catch(() => {});
    res.status(500).json({ error: "PUBLIC_SITE_URL não configurado." });
    return;
  }
  const notificationUrl =
    process.env.MERCADO_PAGO_NOTIFICATION_URL ||
    (API_BASE_URL ? `${API_BASE_URL}/api/webhook-mercadopago` : "");

  const tituloFinal = (titulo && String(titulo).slice(0, 250)) || `Inscrição — ${pendingData.eventNome || "Evento"}`;
  const descricaoFinal = (descricao && String(descricao).slice(0, 600)) || `${qtd} inscrição(ões)`;

  const preferenceBody = {
    items: [
      {
        id: checkoutId,
        title: tituloFinal,
        description: descricaoFinal,
        category_id: "tickets",
        quantity: 1,
        currency_id: "BRL",
        unit_price: Math.round(valor * 100) / 100
      }
    ],
    external_reference: checkoutId,
    metadata: {
      pending_checkout_id: checkoutId,
      event_id: eventId,
      quantidade: qtd
    },
    back_urls: {
      success: `${PUBLIC_SITE_URL}/sucesso?registrationId=${encodeURIComponent(checkoutId)}`,
      pending: `${PUBLIC_SITE_URL}/pendente?registrationId=${encodeURIComponent(checkoutId)}`,
      failure: `${PUBLIC_SITE_URL}/erro?registrationId=${encodeURIComponent(checkoutId)}`
    },
    auto_return: "approved",
    statement_descriptor: "EVENTO",
    payment_methods: {
      excluded_payment_methods: [],
      excluded_payment_types: [
        { id: "atm" },
        { id: "ticket" }
      ],
      installments: 12
    }
  };

  if (notificationUrl) {
    preferenceBody.notification_url = notificationUrl;
  }

  if (payer && (payer.name || payer.phone || payer.email)) {
    preferenceBody.payer = {};
    if (payer.name) {
      const parts = String(payer.name).trim().split(/\s+/);
      preferenceBody.payer.name = parts.shift();
      if (parts.length) preferenceBody.payer.surname = parts.join(" ");
    }
    if (payer.email) {
      const email = String(payer.email).trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        preferenceBody.payer.email = email;
      }
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
        "X-Idempotency-Key": `${checkoutId}-${Date.now()}`
      },
      body: JSON.stringify(preferenceBody)
    });

    const text = await mpResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!mpResp.ok) {
      console.error("Erro MP:", mpResp.status, data);
      await checkoutRef.delete().catch(() => {});
      res.status(502).json({
        error: "Falha ao criar preferência no Mercado Pago.",
        details: data
      });
      return;
    }

    // Salva o preferenceId no pending_checkout (útil para reconciliação)
    await checkoutRef.update({
      preferenceId: data.id || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.warn("Falha ao salvar preferenceId:", err));

    res.status(200).json({
      id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      pendingCheckoutId: checkoutId
    });
  } catch (err) {
    console.error("Exceção criar-preferencia:", err);
    await checkoutRef.delete().catch(() => {});
    res.status(500).json({ error: "Erro interno.", message: err.message });
  }
};
