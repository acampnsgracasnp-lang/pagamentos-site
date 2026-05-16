/* ============================================================
   ADMIN.JS — Painel administrativo (admin.html)
   ------------------------------------------------------------
   Funcionalidades:
   - Login simples (senha local — trocar por Firebase Auth)
   - Listar / criar / editar / ativar-desativar eventos
   - Listar inscritos com filtro por evento e status
   - Exportar inscritos em CSV
   - Ver detalhes de cada inscrição
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     LOGIN SIMPLES (TROCAR EM PRODUÇÃO POR FIREBASE AUTH)
     ------------------------------------------------------------
     IMPORTANTE:
     Esta senha está NO FRONTEND e é apenas para testes.
     QUEM ABRIR O CONSOLE / CÓDIGO-FONTE VERÁ A SENHA.

     Para produção, use Firebase Authentication:
       firebase.auth().signInWithEmailAndPassword(email, senha)
     E proteja a coleção "admins" via Regras do Firestore.
     ============================================================ */
  const ADMIN_PASSWORD = "admin123"; // <-- TROQUE ESTA SENHA
  const SESSION_KEY = "__admin_session_v1";

  const { db } = window.__FB || {};
  if (!db) {
    alert("Firebase não foi configurado. Cole as credenciais em js/firebase-config.js.");
    return;
  }

  // -------------------------- HELPERS --------------------------
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.from(document.querySelectorAll(s)); }

  function formatBRL(v) {
    const n = Number(v) || 0;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr.includes && dateStr.includes("T") ? dateStr : dateStr + "T12:00:00");
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("pt-BR");
    } catch { return dateStr; }
  }

  function formatTimestamp(ts) {
    try {
      if (!ts) return "—";
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    } catch { return "—"; }
  }

  function slugify(s) {
    return (s || "")
      .toString()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  function escapeHTML(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badgeStatus(status) {
    const map = {
      pago: "badge-success",
      pendente: "badge-warning",
      recusado: "badge-danger",
      cancelado: "badge-muted"
    };
    return `<span class="badge ${map[status] || "badge-muted"}">${status || "—"}</span>`;
  }

  // -------------------------- LOGIN ---------------------------
  function isLoggedIn() {
    try {
      return sessionStorage.getItem(SESSION_KEY) === "ok";
    } catch { return false; }
  }

  function login(pw) {
    if (pw === ADMIN_PASSWORD) {
      try { sessionStorage.setItem(SESSION_KEY, "ok"); } catch {}
      return true;
    }
    return false;
  }

  function logout() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    location.reload();
  }

  function bindLogin() {
    $("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const pw = $("#login-password").value;
      if (login(pw)) {
        showAdmin();
      } else {
        alert("Senha incorreta.");
      }
    });
    $("#btn-logout").addEventListener("click", logout);
  }

  function showAdmin() {
    $("#login-screen").classList.add("hidden");
    $("#admin-screen").classList.remove("hidden");
    loadEvents();
    bindTabs();
    bindEventModal();
    bindRegistrations();
  }

  // -------------------------- TABS ----------------------------
  function bindTabs() {
    $$(".tab").forEach(t => {
      t.addEventListener("click", () => {
        $$(".tab").forEach(x => x.classList.remove("active"));
        $$(".tab-content").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        const target = "tab-" + t.getAttribute("data-tab");
        document.getElementById(target).classList.add("active");

        if (t.getAttribute("data-tab") === "registrations") {
          populateEventFilter();
        }
      });
    });
  }

  // -------------------------- EVENTOS -------------------------
  let currentEvents = [];

  async function loadEvents() {
    $("#events-loading").classList.remove("hidden");
    $("#events-empty").classList.add("hidden");
    $("#events-list").innerHTML = "";

    try {
      const snap = await db.collection("events").orderBy("createdAt", "desc").get();
      currentEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      $("#events-loading").classList.add("hidden");

      if (!currentEvents.length) {
        $("#events-empty").classList.remove("hidden");
        return;
      }

      const list = $("#events-list");
      currentEvents.forEach(ev => {
        const limite = Number(ev.limiteIngressos) || 0;
        const vendidos = Number(ev.ingressosVendidos) || 0;
        const restantes = Math.max(0, limite - vendidos);

        const card = document.createElement("div");
        card.className = "event-card";
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <h3>${escapeHTML(ev.nome || "Sem nome")}</h3>
              <div class="slug">/?evento=${escapeHTML(ev.slug || "")}</div>
            </div>
            <span class="badge ${ev.ativo ? "badge-success" : "badge-muted"}">
              ${ev.ativo ? "Ativo" : "Pausado"}
            </span>
          </div>

          <div class="stats">
            <div class="stat">
              <div class="stat-label">Valor</div>
              <div class="stat-value">${formatBRL(ev.valor)}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Vendidos</div>
              <div class="stat-value">${vendidos}/${limite}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Restam</div>
              <div class="stat-value">${restantes}</div>
            </div>
          </div>

          <div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">
            ${ev.dataEvento ? `📅 ${formatDate(ev.dataEvento)}` : ""}
            ${ev.local ? ` • 📍 ${escapeHTML(ev.local)}` : ""}
          </div>

          <div class="card-actions">
            <button class="btn btn-primary btn-sm" data-edit="${ev.id}">Editar</button>
            <button class="btn btn-secondary btn-sm" data-toggle="${ev.id}">
              ${ev.ativo ? "Pausar" : "Ativar"}
            </button>
            <button class="btn btn-secondary btn-sm" data-link="${ev.slug || ""}">Link</button>
            <button class="btn btn-secondary btn-sm" data-regs="${ev.id}">Inscritos</button>
          </div>
        `;
        list.appendChild(card);
      });

      // bind actions
      list.querySelectorAll("[data-edit]").forEach(b => {
        b.addEventListener("click", () => openEditModal(b.getAttribute("data-edit")));
      });
      list.querySelectorAll("[data-toggle]").forEach(b => {
        b.addEventListener("click", () => toggleEvent(b.getAttribute("data-toggle")));
      });
      list.querySelectorAll("[data-link]").forEach(b => {
        b.addEventListener("click", () => {
          const slug = b.getAttribute("data-link");
          const url = `${location.origin}${location.pathname.replace("admin.html", "index.html")}?evento=${slug}`;
          navigator.clipboard?.writeText(url);
          alert("Link copiado:\n" + url);
        });
      });
      list.querySelectorAll("[data-regs]").forEach(b => {
        b.addEventListener("click", () => {
          $$(".tab").forEach(x => x.classList.remove("active"));
          $$(".tab-content").forEach(x => x.classList.remove("active"));
          document.querySelector('[data-tab="registrations"]').classList.add("active");
          $("#tab-registrations").classList.add("active");
          populateEventFilter().then(() => {
            $("#filter-event").value = b.getAttribute("data-regs");
            loadRegistrations();
          });
        });
      });
    } catch (err) {
      console.error(err);
      $("#events-loading").classList.add("hidden");
      alert("Erro ao carregar eventos. Verifique as regras do Firestore.");
    }
  }

  async function toggleEvent(id) {
    const ev = currentEvents.find(e => e.id === id);
    if (!ev) return;
    try {
      await db.collection("events").doc(id).update({
        ativo: !ev.ativo,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      loadEvents();
    } catch (err) {
      alert("Erro ao atualizar: " + err.message);
    }
  }

  // ------------------- MODAL EVENTO ---------------------------
  function bindEventModal() {
    $("#btn-new-event").addEventListener("click", () => openEditModal(null));

    $("#ev-nome").addEventListener("input", (e) => {
      // auto-sugere slug enquanto o usuário digita um novo evento
      const slugField = $("#ev-slug");
      if (!slugField.value || slugField.dataset.auto === "1") {
        slugField.value = slugify(e.target.value);
        slugField.dataset.auto = "1";
      }
      $("#slug-preview").textContent = slugField.value || "slug";
    });
    $("#ev-slug").addEventListener("input", (e) => {
      e.target.value = slugify(e.target.value);
      e.target.dataset.auto = "0";
      $("#slug-preview").textContent = e.target.value || "slug";
    });

    $$("[data-close]").forEach(b => {
      b.addEventListener("click", () => {
        document.getElementById(b.getAttribute("data-close")).classList.remove("show");
      });
    });

    $("#event-form").addEventListener("submit", saveEvent);
  }

  function openEditModal(id) {
    const form = $("#event-form");
    form.reset();
    $("#event-id").value = "";
    $("#ev-slug").dataset.auto = "1";
    $("#slug-preview").textContent = "slug";

    if (id) {
      const ev = currentEvents.find(e => e.id === id);
      if (!ev) return;
      $("#event-modal-title").textContent = "Editar evento";
      $("#event-id").value = id;
      $("#ev-nome").value = ev.nome || "";
      $("#ev-slug").value = ev.slug || "";
      $("#ev-slug").dataset.auto = "0";
      $("#slug-preview").textContent = ev.slug || "slug";
      $("#ev-descricao").value = ev.descricao || "";
      $("#ev-valor").value = ev.valor != null ? ev.valor : "";
      $("#ev-limite").value = ev.limiteIngressos != null ? ev.limiteIngressos : "";
      $("#ev-vendidos").value = ev.ingressosVendidos != null ? ev.ingressosVendidos : 0;
      $("#ev-data").value = ev.dataEvento || "";
      $("#ev-local").value = ev.local || "";
      $("#ev-banner").value = ev.bannerUrl || "";
      $("#ev-ativo").value = String(!!ev.ativo);
      $("#ev-exige-camiseta").value = String(!!ev.exigeCamiseta);
      $("#ev-tamanhos").value = (ev.tamanhosCamiseta || ["PP","P","M","G","GG","XG"]).join(", ");
    } else {
      $("#event-modal-title").textContent = "Novo evento";
      $("#ev-vendidos").value = 0;
      $("#ev-ativo").value = "true";
      $("#ev-exige-camiseta").value = "true";
      $("#ev-tamanhos").value = "PP, P, M, G, GG, XG";
    }

    $("#event-modal").classList.add("show");
  }

  async function saveEvent(e) {
    e.preventDefault();
    const id = $("#event-id").value;
    const slug = slugify($("#ev-slug").value);

    if (!slug) {
      alert("Slug inválido.");
      return;
    }

    // Verificar slug duplicado
    try {
      const dupSnap = await db.collection("events").where("slug", "==", slug).get();
      const dup = dupSnap.docs.find(d => d.id !== id);
      if (dup) {
        alert("Este slug já está em uso por outro evento. Escolha outro.");
        return;
      }
    } catch (err) {
      console.warn("Não foi possível verificar duplicidade:", err);
    }

    const tamanhos = $("#ev-tamanhos").value
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    const data = {
      nome: $("#ev-nome").value.trim(),
      slug: slug,
      descricao: $("#ev-descricao").value.trim(),
      valor: Number($("#ev-valor").value) || 0,
      limiteIngressos: Number($("#ev-limite").value) || 0,
      ingressosVendidos: Number($("#ev-vendidos").value) || 0,
      ativo: $("#ev-ativo").value === "true",
      dataEvento: $("#ev-data").value || "",
      local: $("#ev-local").value.trim(),
      bannerUrl: $("#ev-banner").value.trim(),
      exigeCamiseta: $("#ev-exige-camiseta").value === "true",
      tamanhosCamiseta: tamanhos.length ? tamanhos : ["PP","P","M","G","GG","XG"],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      if (id) {
        await db.collection("events").doc(id).update(data);
      } else {
        data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection("events").add(data);
      }
      $("#event-modal").classList.remove("show");
      loadEvents();
    } catch (err) {
      alert("Erro ao salvar: " + err.message);
    }
  }

  // ------------------- INSCRITOS ------------------------------
  let currentRegs = [];

  async function populateEventFilter() {
    const select = $("#filter-event");
    select.innerHTML = '<option value="">Todos os eventos</option>';
    if (!currentEvents.length) {
      try {
        const snap = await db.collection("events").orderBy("createdAt", "desc").get();
        currentEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch {}
    }
    currentEvents.forEach(ev => {
      const opt = document.createElement("option");
      opt.value = ev.id;
      opt.textContent = ev.nome || ev.slug || ev.id;
      select.appendChild(opt);
    });
  }

  function bindRegistrations() {
    $("#btn-load-regs").addEventListener("click", loadRegistrations);
    $("#btn-export-csv").addEventListener("click", exportCSV);
    populateEventFilter();
  }

  async function loadRegistrations() {
    $("#regs-loading").classList.remove("hidden");
    $("#regs-table-wrap").style.display = "none";
    $("#regs-stats").classList.add("hidden");

    const eventId = $("#filter-event").value;
    const status = $("#filter-status").value;

    try {
      let q = db.collection("registrations");
      if (eventId) q = q.where("eventId", "==", eventId);
      if (status) q = q.where("statusPagamento", "==", status);
      // ordenação por createdAt — pode exigir índice composto se houver filtros
      let snap;
      try {
        snap = await q.orderBy("createdAt", "desc").limit(500).get();
      } catch (err) {
        // fallback caso o índice não exista
        snap = await q.limit(500).get();
      }
      currentRegs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      renderRegs();
    } catch (err) {
      console.error(err);
      alert("Erro ao carregar inscritos: " + err.message);
      $("#regs-loading").classList.add("hidden");
    }
  }

  function renderRegs() {
    $("#regs-loading").classList.add("hidden");
    const tbody = $("#regs-tbody");
    tbody.innerHTML = "";

    if (!currentRegs.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:30px">Nenhuma inscrição encontrada.</td></tr>';
      $("#regs-table-wrap").style.display = "block";
      return;
    }

    // Stats
    let totalArrecadado = 0;
    let pagos = 0, pendentes = 0;
    currentRegs.forEach(r => {
      if (r.statusPagamento === "pago") {
        pagos++;
        totalArrecadado += Number(r.valorTotal) || 0;
      } else if (r.statusPagamento === "pendente") {
        pendentes++;
      }
    });

    $("#stat-total").textContent = currentRegs.length;
    $("#stat-pagos").textContent = pagos;
    $("#stat-pendentes").textContent = pendentes;
    $("#stat-arrecadado").textContent = formatBRL(totalArrecadado);
    $("#regs-stats").classList.remove("hidden");

    currentRegs.forEach(r => {
      const tr = document.createElement("tr");
      const principal = (r.participantes && r.participantes[0]) || {};
      tr.innerHTML = `
        <td>${formatTimestamp(r.createdAt)}</td>
        <td>${escapeHTML(r.eventNome || r.eventSlug || "—")}</td>
        <td>${escapeHTML(principal.nome || "—")}</td>
        <td>${escapeHTML(principal.telefone || "—")}</td>
        <td>${r.quantidade || 1}</td>
        <td>${formatBRL(r.valorTotal)}</td>
        <td>${badgeStatus(r.statusPagamento)}</td>
        <td><button class="btn btn-secondary btn-sm" data-view="${r.id}">Ver</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-view]").forEach(b => {
      b.addEventListener("click", () => openRegModal(b.getAttribute("data-view")));
    });

    $("#regs-table-wrap").style.display = "block";
  }

  function openRegModal(id) {
    const r = currentRegs.find(x => x.id === id);
    if (!r) return;
    const body = $("#reg-modal-body");

    const participantesHtml = (r.participantes || []).map((p, i) => `
      <div class="participant-block" style="margin-bottom:12px">
        <div class="participant-header">
          <div class="participant-number">${i + 1}</div>
          <div class="participant-title">${escapeHTML(p.nome || "Participante " + (i+1))}</div>
        </div>
        <div style="font-size:14px;line-height:1.7">
          <div><b>Telefone:</b> ${escapeHTML(p.telefone || "—")}</div>
          <div><b>Cidade:</b> ${escapeHTML(p.cidade || "—")}</div>
          <div><b>Comunidade:</b> ${escapeHTML(p.comunidade || "—")}</div>
          <div><b>Pastoral:</b> ${escapeHTML(p.pastoral || "—")}</div>
          <div><b>Endereço:</b> ${escapeHTML(p.endereco || "—")}</div>
          <div><b>Camiseta:</b> ${
            p.desejaCamiseta
              ? "Sim — tamanho " + escapeHTML(p.tamanhoCamiseta || "?")
              : (p.desejaCamiseta === false ? "Não" : "—")
          }</div>
        </div>
      </div>
    `).join("");

    body.innerHTML = `
      <div style="margin-bottom:14px">
        <div><b>Evento:</b> ${escapeHTML(r.eventNome || r.eventSlug || r.eventId)}</div>
        <div><b>Status:</b> ${badgeStatus(r.statusPagamento)}</div>
        <div><b>Valor total:</b> ${formatBRL(r.valorTotal)}</div>
        <div><b>Criado em:</b> ${formatTimestamp(r.createdAt)}</div>
        <div><b>ID MP Preference:</b> ${escapeHTML(r.mercadoPagoPreferenceId || "—")}</div>
        <div><b>ID MP Payment:</b> ${escapeHTML(r.mercadoPagoPaymentId || "—")}</div>
        <div><b>Registration ID:</b> <code>${r.id}</code></div>
      </div>
      <h3 style="margin:18px 0 10px;font-size:15px">Participantes (${r.quantidade || 1})</h3>
      ${participantesHtml}
    `;
    $("#reg-modal").classList.add("show");
  }

  // ------------------- EXPORTAR CSV ---------------------------
  function exportCSV() {
    if (!currentRegs.length) {
      alert("Carregue os inscritos primeiro.");
      return;
    }

    const rows = [[
      "Data", "Evento", "Status", "Valor Total", "Qtd",
      "Nome", "Telefone", "Cidade", "Comunidade", "Pastoral",
      "Endereço", "Camiseta", "Tamanho",
      "PreferenceId", "PaymentId", "RegistrationId"
    ]];

    currentRegs.forEach(r => {
      const evNome = r.eventNome || r.eventSlug || "";
      const created = formatTimestamp(r.createdAt);
      (r.participantes || [{}]).forEach((p, idx) => {
        rows.push([
          idx === 0 ? created : "",
          idx === 0 ? evNome : "",
          idx === 0 ? (r.statusPagamento || "") : "",
          idx === 0 ? String(r.valorTotal ?? "") : "",
          idx === 0 ? String(r.quantidade ?? "") : "",
          p.nome || "",
          p.telefone || "",
          p.cidade || "",
          p.comunidade || "",
          p.pastoral || "",
          p.endereco || "",
          p.desejaCamiseta ? "Sim" : (p.desejaCamiseta === false ? "Não" : ""),
          p.tamanhoCamiseta || "",
          idx === 0 ? (r.mercadoPagoPreferenceId || "") : "",
          idx === 0 ? (r.mercadoPagoPaymentId || "") : "",
          idx === 0 ? r.id : ""
        ]);
      });
    });

    const csv = rows.map(r =>
      r.map(cell => {
        const s = String(cell ?? "").replace(/"/g, '""');
        return /[",;\n]/.test(s) ? `"${s}"` : s;
      }).join(";")
    ).join("\r\n");

    // BOM para Excel reconhecer UTF-8
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inscritos_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // -------------------------- INIT ---------------------------
  document.addEventListener("DOMContentLoaded", () => {
    bindLogin();
    if (isLoggedIn()) showAdmin();
  });
})();
