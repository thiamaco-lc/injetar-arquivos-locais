$(function () {
  const $container = $("#files-container");

  // Estado em memória (fonte da verdade). Persistido em chrome.storage.local.
  const estado = {
    itens: [],
    habilitado: true,
    autoInject: true,
    autoReload: false,
    baseDomain: "",
    intervalo: 1000,
  };

  const TIPOS = ["css", "js", "html"];

  // ---------------------------------------------------------------- utils ----
  function gerarId() {
    return (
      (crypto?.randomUUID?.() || "id-" + Math.random().toString(36).slice(2)) +
      Date.now().toString(36)
    );
  }

  function detectarTipo(str) {
    const s = (str || "").split("?")[0].split("#")[0].toLowerCase();
    if (s.endsWith(".css")) return "css";
    if (s.endsWith(".js") || s.endsWith(".mjs")) return "js";
    if (s.endsWith(".html") || s.endsWith(".htm")) return "html";
    return "";
  }

  function itemNovo() {
    return {
      id: gerarId(),
      tipo: "",
      tipoManual: false,
      url: "",
      conteudo: "",
      nome: "",
      seletor: "body",
      posicao: "append",
      ativo: true,
    };
  }

  let salvarTimer = null;
  function salvar(aplicarDepois = true) {
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => {
      chrome.storage.local.set({
        itens: estado.itens,
        habilitado: estado.habilitado,
        autoInject: estado.autoInject,
        autoReload: estado.autoReload,
        baseDomain: estado.baseDomain,
        intervalo: estado.intervalo,
      });
      if (aplicarDepois) aplicar();
    }, 250);
  }

  let aplicarTimer = null;
  function aplicar(feedback = false) {
    clearTimeout(aplicarTimer);
    aplicarTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ action: "aplicar", forcar: true }, (resp) => {
        void chrome.runtime.lastError; // ignora "sem página válida"
        if (feedback) mostrarStatus(resp);
      });
    }, 200);
  }

  let statusTimer = null;
  function mostrarStatus(resp) {
    const $s = $("#status").removeClass("warn err ok");
    clearTimeout(statusTimer);
    if (resp && resp.ok) {
      $s.addClass("ok").text("✔️ Aplicado nesta aba.");
      statusTimer = setTimeout(() => $s.text("").removeClass("ok"), 2000);
      return;
    }
    const msgs = {
      "sem-dominio": "⚠️ Defina um domínio base para a extensão agir (🎯 usa a aba atual).",
      "fora-dominio": "Esta aba está fora do domínio base — nada foi injetado.",
      "pagina-interna": "Página interna do navegador — não é possível injetar aqui.",
    };
    const motivo = (resp && resp.motivo) || "";
    $s.addClass(motivo === "sem-dominio" ? "warn" : "err").text(
      msgs[motivo] || "Não foi possível aplicar."
    );
  }

  // ------------------------------------------------------------- render ----
  function renderLinha(item) {
    const $row = $(`
      <div class="file-row" draggable="true">
        <span class="drag-handle" title="Arraste para reordenar">⠿</span>
        <span class="type-badge" data-tipo="${item.tipo}" title="Clique para trocar o tipo">${
          (item.tipo || "auto").toUpperCase()
        }</span>
        <input type="text" class="file-url ${item.conteudo ? "local" : ""}"
          placeholder="URL do arquivo (ex: http://localhost:3000/css/style.css)"
          value="${item.conteudo ? "📄 " + (item.nome || "arquivo local") : item.url}"
          ${item.conteudo ? "readonly" : ""} />
        <input type="file" class="file-input" accept=".css,.js,.mjs,.html,.htm" hidden />
        <button class="icon-btn pick-file" title="Escolher arquivo do disco">📁</button>
        <label class="toggle" title="Ativar/desativar esta injeção">
          <input type="checkbox" class="ativo" ${item.ativo ? "checked" : ""}>
          <div class="track"></div>
        </label>
        <button class="icon-btn remove-btn" title="Remover">✕</button>
        <div class="html-opts ${item.tipo === "html" ? "" : "hidden"}">
          <input type="text" class="html-selector" placeholder="Seletor (ex: body, #app, .header)"
            value="${item.seletor || "body"}">
          <label>onde:</label>
          <select class="html-pos">
            <option value="append" ${item.posicao === "append" ? "selected" : ""}>no fim</option>
            <option value="prepend" ${item.posicao === "prepend" ? "selected" : ""}>no início</option>
            <option value="replace" ${item.posicao === "replace" ? "selected" : ""}>substituir</option>
          </select>
        </div>
      </div>
    `);

    const $url = $row.find(".file-url");
    const $badge = $row.find(".type-badge");
    const $htmlOpts = $row.find(".html-opts");

    function atualizarBadge() {
      $badge.attr("data-tipo", item.tipo).text((item.tipo || "auto").toUpperCase());
      $htmlOpts.toggleClass("hidden", item.tipo !== "html");
    }

    // URL digitada -> auto-detecta o tipo (a menos que o usuário tenha travado)
    $url.on("input", function () {
      if (item.conteudo) return; // linha de arquivo local: URL é só rótulo
      item.url = this.value.trim();
      item.nome = "";
      if (!item.tipoManual) {
        item.tipo = detectarTipo(item.url);
        atualizarBadge();
      }
      salvar();
    });

    // Clique no badge -> cicla o tipo manualmente (auto -> css -> js -> html)
    $badge.on("click", function () {
      const idx = TIPOS.indexOf(item.tipo);
      item.tipo = TIPOS[(idx + 1) % TIPOS.length];
      item.tipoManual = true;
      atualizarBadge();
      salvar();
    });

    // Escolher arquivo local
    $row.find(".pick-file").on("click", () => $row.find(".file-input").trigger("click"));
    $row.find(".file-input").on("change", function () {
      const file = this.files && this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        item.conteudo = String(reader.result);
        item.nome = file.name;
        item.url = "";
        if (!item.tipoManual) item.tipo = detectarTipo(file.name) || item.tipo;
        $url.val("📄 " + file.name).prop("readonly", true).addClass("local");
        atualizarBadge();
        salvar();
      };
      reader.readAsText(file);
    });

    // Duplo clique no campo local -> volta a ser URL editável
    $url.on("dblclick", function () {
      if (!item.conteudo) return;
      item.conteudo = "";
      item.nome = "";
      $(this).val("").prop("readonly", false).removeClass("local");
      salvar();
    });

    // Toggle ativo
    $row.find(".ativo").on("change", function () {
      item.ativo = this.checked;
      salvar();
    });

    // Remover
    $row.find(".remove-btn").on("click", () => {
      estado.itens = estado.itens.filter((i) => i.id !== item.id);
      $row.remove();
      salvar();
    });

    // Opções de HTML
    $row.find(".html-selector").on("input", function () {
      item.seletor = this.value.trim() || "body";
      salvar();
    });
    $row.find(".html-pos").on("change", function () {
      item.posicao = this.value;
      salvar();
    });

    return $row;
  }

  // --------------------------------------------------- drag & drop reorder ----
  let $dragging = null;
  $container.on("dragstart", ".file-row", function (e) {
    if ($(e.target).is("input, select, textarea")) {
      e.preventDefault();
      return;
    }
    $dragging = $(this);
    $(this).addClass("dragging");
    e.originalEvent.dataTransfer.effectAllowed = "move";
  });
  $container.on("dragend", ".file-row", function () {
    $(this).removeClass("dragging");
    $dragging = null;
    reordenarEstado();
  });
  $container.on("dragover", ".file-row", function (e) {
    e.preventDefault();
    if (!$dragging || this === $dragging[0]) return;
    const rect = this.getBoundingClientRect();
    const depois = (e.originalEvent.clientY - rect.top) / rect.height > 0.5;
    this.parentNode.insertBefore($dragging[0], depois ? this.nextSibling : this);
  });

  function reordenarEstado() {
    // Reconstroi a lista na ordem atual do DOM, usando o data-id de cada linha.
    const novos = [];
    $container.find(".file-row").each(function () {
      const it = estado.itens.find((i) => i.id === $(this).data("id"));
      if (it) novos.push(it);
    });
    if (novos.length === estado.itens.length) {
      estado.itens = novos;
      salvar();
    }
  }

  // ---------------------------------------------------------- controles ----
  $("#add").on("click", () => {
    const it = itemNovo();
    estado.itens.push(it);
    const $row = renderLinha(it).data("id", it.id);
    $container.append($row);
  });

  $("#apply").on("click", () => aplicar(true));

  $("#master-toggle").on("change", function () {
    estado.habilitado = this.checked;
    salvar();
  });

  $("#auto-inject").on("change", function () {
    estado.autoInject = this.checked;
    salvar(false);
  });

  $("#auto-reload").on("change", function () {
    estado.autoReload = this.checked;
    salvar();
  });

  $("#intervalo").on("input", function () {
    const v = parseInt(this.value, 10);
    estado.intervalo = isNaN(v) || v < 100 ? 1000 : v;
    salvar(false);
  });

  $("#base-domain").on("input", function () {
    estado.baseDomain = this.value.trim();
    salvar(false);
  });

  $("#use-tab").on("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !tab.url) return;
      try {
        const u = new URL(tab.url);
        estado.baseDomain = `${u.protocol}//${u.host}`;
        $("#base-domain").val(estado.baseDomain);
        salvar(false);
      } catch {}
    });
  });

  // ----------------------------------------------------------- carregar ----
  chrome.storage.local.get(null, (r) => {
    estado.itens = Array.isArray(r.itens) ? r.itens : [];
    estado.habilitado = r.habilitado !== false;
    estado.autoInject = r.autoInject !== false;
    estado.autoReload = !!r.autoReload;
    estado.baseDomain = r.baseDomain || "";
    estado.intervalo = Number(r.intervalo) || 1000;

    // normaliza itens do formato antigo, se houver
    if (estado.itens.length === 0 && Array.isArray(r.arquivos)) {
      estado.itens = r.arquivos.map((a) => ({
        ...itemNovo(),
        tipo: a.tipo || detectarTipo(a.url) || "",
        tipoManual: !!a.tipo,
        url: a.url || "",
        ativo: a.ativo !== false,
      }));
    }
    estado.itens.forEach((i) => {
      if (i.id == null) i.id = gerarId();
      if (i.seletor == null) i.seletor = "body";
      if (i.posicao == null) i.posicao = "append";
    });

    if (estado.itens.length === 0) estado.itens.push(itemNovo());

    // reflete na UI
    $("#master-toggle").prop("checked", estado.habilitado);
    $("#auto-inject").prop("checked", estado.autoInject);
    $("#auto-reload").prop("checked", estado.autoReload);
    $("#base-domain").val(estado.baseDomain);
    $("#intervalo").val(estado.intervalo);

    // render com data-id em cada linha
    $container.empty();
    estado.itens.forEach((item) => {
      const $row = renderLinha(item).data("id", item.id);
      $container.append($row);
    });

    // aplica ao abrir; com feedback, pra avisar caso falte o domínio base
    aplicar(true);
  });
});
