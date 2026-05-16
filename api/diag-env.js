/* ============================================================
   /api/diag-env.js — endpoint TEMPORÁRIO de diagnóstico.

   Retorna APENAS nomes e metadados das variáveis de ambiente
   relacionadas ao pagamento (sem expor valores). Use para
   confirmar se a env chegou no runtime da Vercel após deploy.

   Remover este arquivo depois de validar a configuração.
   ============================================================ */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const wanted = [
    "MERCADO_PAGO_ACCESS_TOKEN",
    "MERCADO_PAGO_NOTIFICATION_URL",
    "PUBLIC_SITE_URL",
    "API_BASE_URL"
  ];

  const status = {};
  for (const name of wanted) {
    const raw = process.env[name];
    status[name] = {
      present: typeof raw === "string" && raw.length > 0,
      length: typeof raw === "string" ? raw.length : 0,
      trimmedLength: typeof raw === "string" ? raw.trim().length : 0,
      startsWith: typeof raw === "string" ? raw.slice(0, 8) : null
    };
  }

  const mpVarNames = Object.keys(process.env)
    .filter((k) => /MERCADO|MP_|PAGO|ACCESS_TOKEN|PUBLIC_SITE|API_BASE/i.test(k))
    .sort();

  res.status(200).json({
    ok: true,
    vercelEnv: process.env.VERCEL_ENV || null,
    region: process.env.VERCEL_REGION || null,
    deploymentUrl: process.env.VERCEL_URL || null,
    wanted: status,
    mpVarNames
  });
};
