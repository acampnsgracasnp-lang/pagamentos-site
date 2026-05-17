/* ============================================================
   /api/sincronizar-pagamentos.js
   ------------------------------------------------------------
   Vercel Function — fallback do webhook do Mercado Pago.

   Duas passagens:
     1) pending_checkouts com status "aguardando" → busca pagamento
        no MP por external_reference e, se encontrar, materializa
        o documento em /registrations (mesma lógica do webhook).
     2) registrations existentes com statusPagamento "pendente" →
        reconsulta o pagamento no MP e atualiza status + contadores
        se necessário.

   Use para:
     - Reconciliar pagamentos quando o webhook falhou
     - Forçar sincronização manual a partir do painel admin

   BODY (POST JSON, todos opcionais):
     {
       "eventId":    "string",
       "sinceHours": 168,
       "limit":      200
     }

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - FIREBASE_SERVICE_ACCOUNT
     - FIREBASE_PROJECT_ID (opcional)
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

function mapStatus(mpStatus) {
  switch (mpStatus) {
    case "approved": return "pago";
    case "pending":
    case "in_process":
    case "authorized": return "pendente";
    case "rejected": return "recusado";
    case "cancelled":
    case "refunded":
    case "charged_back": return "cancelado";
    default: return "pendente";
  }
}

function camisetasPorTamanho(participantes) {
  const out = {};
  (participantes || []).forEach(p => {
    const sz = p && p.tamanhoCamiseta;
    if (sz && !/n[ãa]o\s*dese/i.test(String(sz))) {
      out[sz] = (out[sz] || 0) + 1;
    }
  });
  return out;
}

async function buscarPagamento(ACCESS_TOKEN, externalRef) {
  const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}&sort=date_created&criteria=desc&limit=10`;
  const mpResp = await fetch(searchUrl, { headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` } });
  if (!mpResp.ok) {
    return { error: `MP search ${mpResp.status}`, results: [] };
  }
  const data = await mpResp.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return { results: [] };

  const ordem = (p) => {
    const s = p.status;
    if (s === "approved") return 0;
    if (s === "in_process" || s === "pending" || s === "authorized") return 1;
    if (s === "rejected" || s === "cancelled" || s === "refunded" || s === "charged_back") return 2;
    return 3;
  };
  results.sort((a, b) => {
    const d = ordem(a) - ordem(b);
    if (d !== 0) return d;
    return new Date(b.date_created || 0) - new Date(a.date_created || 0);
  });
  return { results, payment: results[0] };
}

// Aplica a mesma lógica do webhook: cria registration a partir do pending_checkout
// (se ainda não existir) e/ou atualiza status. Idempotente (doc id == externalRef).
async function materializar(db, externalRef, payment) {
  const mpStatus = payment.status;
  const novoStatus = mapStatus(mpStatus);
  const paymentId = String(payment.id);

  const regRef = db.collection("registrations").doc(externalRef);
  const pendingRef = db.collection("pending_checkouts").doc(externalRef);

  return await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(regRef);
    const pendingSnap = regSnap.exists ? null : await tx.get(pendingRef);

    let eventId = null;
    if (regSnap.exists) eventId = regSnap.data().eventId;
    else if (pendingSnap && pendingSnap.exists) eventId = pendingSnap.data().eventId;

    const evRef = eventId ? db.collection("events").doc(eventId) : null;
    const evSnap = evRef ? await tx.get(evRef) : null;

    let statusAnterior;
    let registrationData;
    let acao;

    if (regSnap.exists) {
      const reg = regSnap.data();
      statusAnterior = reg.statusPagamento || "pendente";
      registrationData = reg;

      if (statusAnterior === novoStatus && reg.mercadoPagoPaymentId === paymentId) {
        return { acao: "noop", statusAnterior, novoStatus };
      }
      acao = "update";

      const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
      if (statusAnterior === "pago" && novoStatus !== "pago" && !isEstornoReal) {
        tx.update(regRef, {
          mercadoPagoPaymentId: paymentId,
          mercadoPagoStatusDetail: payment.status_detail || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        tx.update(regRef, {
          statusPagamento: novoStatus,
          mercadoPagoPaymentId: paymentId,
          mercadoPagoStatusDetail: payment.status_detail || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } else if (pendingSnap && pendingSnap.exists) {
      const pending = pendingSnap.data();
      statusAnterior = "pendente";
      registrationData = pending;
      acao = "create";

      tx.set(regRef, {
        eventId: pending.eventId,
        eventSlug: pending.eventSlug || "",
        eventNome: pending.eventNome || "",
        quantidade: Number(pending.quantidade) || 1,
        valorTotal: Number(pending.valorTotal) || 0,
        valorUnitario: Number(pending.valorUnitario) || 0,
        participantes: pending.participantes || [],
        statusPagamento: novoStatus,
        mercadoPagoPreferenceId: pending.preferenceId || "",
        mercadoPagoPaymentId: paymentId,
        mercadoPagoStatusDetail: payment.status_detail || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(pendingRef, {
        status: "consumido",
        consumedAt: admin.firestore.FieldValue.serverTimestamp(),
        mercadoPagoPaymentId: paymentId
      });
    } else {
      return { acao: "skip", reason: "sem doc" };
    }

    const cams = camisetasPorTamanho(registrationData.participantes);
    const qtd = Number(registrationData.quantidade) || 1;

    if (novoStatus === "pago" && statusAnterior !== "pago" && evSnap && evSnap.exists) {
      const ev = evSnap.data();
      const vendidos = Number(ev.ingressosVendidos) || 0;
      const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
      Object.entries(cams).forEach(([sz, n]) => {
        vendidoCam[sz] = (Number(vendidoCam[sz]) || 0) + n;
      });
      tx.update(evRef, {
        ingressosVendidos: vendidos + qtd,
        vendidoCamisetas: vendidoCam,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
    if (isEstornoReal && evSnap && evSnap.exists) {
      const ev = evSnap.data();
      const vendidos = Number(ev.ingressosVendidos) || 0;
      const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
      Object.entries(cams).forEach(([sz, n]) => {
        vendidoCam[sz] = Math.max(0, (Number(vendidoCam[sz]) || 0) - n);
      });
      tx.update(evRef, {
        ingressosVendidos: Math.max(0, vendidos - qtd),
        vendidoCamisetas: vendidoCam,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { acao, statusAnterior, novoStatus };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Use POST." });
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

  const eventId = typeof body.eventId === "string" && body.eventId ? body.eventId : null;
  const sinceHours = Number.isFinite(Number(body.sinceHours))
    ? Math.max(1, Math.min(24 * 30, Number(body.sinceHours))) : 168;
  const limit = Number.isFinite(Number(body.limit))
    ? Math.max(1, Math.min(500, Number(body.limit))) : 100;

  try {
    initFirebase();
    const db = admin.firestore();
    const sinceDate = new Date(Date.now() - sinceHours * 3600 * 1000);

    const summary = {
      checked: 0,
      updated: 0,
      created: 0,
      pagos: 0,
      recusados: 0,
      cancelados: 0,
      semPagamento: 0,
      ignoradosPorIdade: 0,
      erros: 0,
      detalhes: []
    };

    // ===== PASSAGEM 1: pending_checkouts aguardando =====
    let pendingSnap;
    try {
      pendingSnap = await db.collection("pending_checkouts")
        .where("status", "==", "aguardando")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
    } catch {
      pendingSnap = await db.collection("pending_checkouts")
        .where("status", "==", "aguardando")
        .limit(limit)
        .get();
    }

    for (const docSnap of pendingSnap.docs) {
      const pending = docSnap.data();
      const checkoutId = docSnap.id;
      if (eventId && pending.eventId !== eventId) continue;

      const createdAtDate = pending.createdAt && pending.createdAt.toDate ? pending.createdAt.toDate() : null;
      if (createdAtDate && createdAtDate < sinceDate) {
        summary.ignoradosPorIdade++;
        continue;
      }

      summary.checked++;
      try {
        const { payment, error } = await buscarPagamento(ACCESS_TOKEN, checkoutId);
        if (error) { summary.erros++; summary.detalhes.push({ checkoutId, error }); continue; }
        if (!payment) { summary.semPagamento++; continue; }

        const result = await materializar(db, checkoutId, payment);
        if (result.acao === "create" || result.acao === "update") {
          summary.updated++;
          if (result.acao === "create") summary.created++;
          if (result.novoStatus === "pago") summary.pagos++;
          else if (result.novoStatus === "recusado") summary.recusados++;
          else if (result.novoStatus === "cancelado") summary.cancelados++;
        }

        // Log em /payments
        const logDocId = `${payment.id}_${payment.status || "unknown"}`;
        await db.collection("payments").doc(logDocId).set({
          registrationId: checkoutId,
          paymentId: String(payment.id),
          mpStatus: payment.status,
          mpStatusDetail: payment.status_detail || "",
          novoStatus: mapStatus(payment.status),
          valor: payment.transaction_amount || 0,
          metodo: payment.payment_method_id || "",
          tipo: payment.payment_type_id || "",
          payerEmail: (payment.payer && payment.payer.email) || "",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "sync"
        }, { merge: true });
      } catch (err) {
        summary.erros++;
        summary.detalhes.push({ checkoutId, error: err.message });
      }
    }

    // ===== PASSAGEM 2: registrations já existentes em pendente =====
    let q = db.collection("registrations").where("statusPagamento", "==", "pendente");
    if (eventId) q = q.where("eventId", "==", eventId);
    let regSnap;
    try {
      regSnap = await q.orderBy("createdAt", "desc").limit(limit).get();
    } catch {
      regSnap = await q.limit(limit).get();
    }

    for (const docSnap of regSnap.docs) {
      const reg = docSnap.data();
      const registrationId = docSnap.id;
      const createdAtDate = reg.createdAt && reg.createdAt.toDate ? reg.createdAt.toDate() : null;
      if (createdAtDate && createdAtDate < sinceDate) {
        summary.ignoradosPorIdade++;
        continue;
      }

      summary.checked++;
      try {
        const { payment, error } = await buscarPagamento(ACCESS_TOKEN, registrationId);
        if (error) { summary.erros++; summary.detalhes.push({ registrationId, error }); continue; }
        if (!payment) { summary.semPagamento++; continue; }

        const result = await materializar(db, registrationId, payment);
        if (result.acao === "update" || result.acao === "create") {
          summary.updated++;
          if (result.novoStatus === "pago") summary.pagos++;
          else if (result.novoStatus === "recusado") summary.recusados++;
          else if (result.novoStatus === "cancelado") summary.cancelados++;
        }

        const logDocId = `${payment.id}_${payment.status || "unknown"}`;
        await db.collection("payments").doc(logDocId).set({
          registrationId,
          paymentId: String(payment.id),
          mpStatus: payment.status,
          mpStatusDetail: payment.status_detail || "",
          novoStatus: mapStatus(payment.status),
          valor: payment.transaction_amount || 0,
          metodo: payment.payment_method_id || "",
          tipo: payment.payment_type_id || "",
          payerEmail: (payment.payer && payment.payer.email) || "",
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "sync"
        }, { merge: true });
      } catch (err) {
        summary.erros++;
        summary.detalhes.push({ registrationId, error: err.message });
      }
    }

    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("Erro no sincronizar-pagamentos:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
