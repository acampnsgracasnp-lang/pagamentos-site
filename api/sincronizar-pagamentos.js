/* ============================================================
   /api/sincronizar-pagamentos.js
   ------------------------------------------------------------
   Vercel Function — backup do webhook do Mercado Pago.

   Percorre registrations com statusPagamento = "pendente",
   consulta o MP por external_reference (registrationId) e aplica
   a mesma lógica do webhook: atualiza status, paymentId e (quando
   vira "pago") incrementa events.ingressosVendidos + vendidoCamisetas.

   Use para:
     - reconciliar pagamentos quando o webhook falhou/não foi configurado
     - sincronizar manualmente o painel admin

   BODY (POST JSON, todos opcionais):
     {
       "eventId":    "string",   // limita a um evento
       "sinceHours": 168,        // só pendentes criados há até X horas (default 168 = 7 dias)
       "limit":      200         // máx. registrations a processar
     }

   VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS:
     - MERCADO_PAGO_ACCESS_TOKEN
     - FIREBASE_SERVICE_ACCOUNT
     - FIREBASE_PROJECT_ID (opcional se já estiver no service account)
   ============================================================ */

const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT não configurado.");
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT precisa ser JSON válido em uma única linha.");
  }
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
  const sinceHours = Number.isFinite(Number(body.sinceHours)) ? Math.max(1, Math.min(24 * 30, Number(body.sinceHours))) : 168;
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(500, Number(body.limit))) : 100;

  try {
    initFirebase();
    const db = admin.firestore();

    const sinceDate = new Date(Date.now() - sinceHours * 3600 * 1000);

    let q = db.collection("registrations").where("statusPagamento", "==", "pendente");
    if (eventId) q = q.where("eventId", "==", eventId);

    let snap;
    try {
      snap = await q.orderBy("createdAt", "desc").limit(limit).get();
    } catch {
      snap = await q.limit(limit).get();
    }

    const summary = {
      checked: 0,
      updated: 0,
      pagos: 0,
      recusados: 0,
      cancelados: 0,
      semPagamento: 0,
      ignoradosPorIdade: 0,
      erros: 0,
      detalhes: []
    };

    for (const docSnap of snap.docs) {
      const reg = docSnap.data();
      const registrationId = docSnap.id;

      const createdAtDate = reg.createdAt && reg.createdAt.toDate ? reg.createdAt.toDate() : null;
      if (createdAtDate && createdAtDate < sinceDate) {
        summary.ignoradosPorIdade++;
        continue;
      }

      summary.checked++;

      try {
        const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(registrationId)}&sort=date_created&criteria=desc&limit=10`;
        const mpResp = await fetch(searchUrl, {
          headers: { "Authorization": `Bearer ${ACCESS_TOKEN}` }
        });

        if (!mpResp.ok) {
          summary.erros++;
          summary.detalhes.push({ registrationId, error: `MP search ${mpResp.status}` });
          continue;
        }

        const data = await mpResp.json();
        const results = Array.isArray(data.results) ? data.results : [];

        if (!results.length) {
          summary.semPagamento++;
          continue;
        }

        // Escolhe o pagamento mais relevante: aprovado > in_process/pending > o resto (mais recente)
        const ordemPrioridade = (p) => {
          const s = p.status;
          if (s === "approved") return 0;
          if (s === "in_process" || s === "pending" || s === "authorized") return 1;
          if (s === "rejected" || s === "cancelled" || s === "refunded" || s === "charged_back") return 2;
          return 3;
        };
        results.sort((a, b) => {
          const d = ordemPrioridade(a) - ordemPrioridade(b);
          if (d !== 0) return d;
          return new Date(b.date_created || 0) - new Date(a.date_created || 0);
        });
        const payment = results[0];
        const mpStatus = payment.status;
        const novoStatus = mapStatus(mpStatus);
        const paymentId = String(payment.id);

        const regRef = db.collection("registrations").doc(registrationId);

        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(regRef);
          if (!fresh.exists) return;
          const r = fresh.data();
          const statusAnterior = r.statusPagamento || "pendente";

          if (statusAnterior === novoStatus && r.mercadoPagoPaymentId === paymentId) {
            return;
          }

          tx.update(regRef, {
            statusPagamento: novoStatus,
            mercadoPagoPaymentId: paymentId,
            mercadoPagoStatusDetail: payment.status_detail || "",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          const evRef = r.eventId ? db.collection("events").doc(r.eventId) : null;
          const camisetasPorTamanho = {};
          (r.participantes || []).forEach(p => {
            const sz = p && p.tamanhoCamiseta;
            if (sz && !/n[ãa]o\s*dese/i.test(String(sz))) {
              camisetasPorTamanho[sz] = (camisetasPorTamanho[sz] || 0) + 1;
            }
          });

          if (novoStatus === "pago" && statusAnterior !== "pago" && evRef) {
            const evSnap = await tx.get(evRef);
            if (evSnap.exists) {
              const ev = evSnap.data();
              const vendidos = Number(ev.ingressosVendidos) || 0;
              const qtd = Number(r.quantidade) || 1;
              const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
              Object.entries(camisetasPorTamanho).forEach(([sz, n]) => {
                vendidoCam[sz] = (Number(vendidoCam[sz]) || 0) + n;
              });
              tx.update(evRef, {
                ingressosVendidos: vendidos + qtd,
                vendidoCamisetas: vendidoCam,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }

          const isEstornoReal = statusAnterior === "pago" && novoStatus === "cancelado";
          if (isEstornoReal && evRef) {
            const evSnap = await tx.get(evRef);
            if (evSnap.exists) {
              const ev = evSnap.data();
              const vendidos = Number(ev.ingressosVendidos) || 0;
              const qtd = Number(r.quantidade) || 1;
              const vendidoCam = Object.assign({}, ev.vendidoCamisetas || {});
              Object.entries(camisetasPorTamanho).forEach(([sz, n]) => {
                vendidoCam[sz] = Math.max(0, (Number(vendidoCam[sz]) || 0) - n);
              });
              tx.update(evRef, {
                ingressosVendidos: Math.max(0, vendidos - qtd),
                vendidoCamisetas: vendidoCam,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          }

          if (statusAnterior === "pago" && novoStatus !== "pago" && !isEstornoReal) {
            tx.update(regRef, { statusPagamento: "pago" });
          }
        });

        summary.updated++;
        if (novoStatus === "pago") summary.pagos++;
        else if (novoStatus === "recusado") summary.recusados++;
        else if (novoStatus === "cancelado") summary.cancelados++;

        // Log em /payments
        const logDocId = `${paymentId}_${mpStatus || "unknown"}`;
        await db.collection("payments").doc(logDocId).set({
          registrationId,
          paymentId,
          mpStatus,
          mpStatusDetail: payment.status_detail || "",
          novoStatus,
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
