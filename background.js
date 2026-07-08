// ============================================================================
//  Injetar Arquivos Locais — service worker
//  Centraliza a injeção de CSS/JS/HTML e o watcher de auto-reload (gulp watch).
// ============================================================================

// --- Migração para o formato de perfis por domínio --------------------------
//  perfis: { [dominio]: { itens, autoInject, autoReload, intervalo } }
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (r) => {
    if (r.perfis) return; // já migrado

    let itens = Array.isArray(r.itens)
      ? r.itens
      : Array.isArray(r.arquivos)
      ? r.arquivos.map((a) => ({
          id: gerarId(),
          tipo: a.tipo || detectarTipo(a.url) || "",
          tipoManual: !!a.tipo,
          url: a.url || "",
          seletor: "body",
          posicao: "append",
          ativo: a.ativo !== false,
        }))
      : [];

    const perfis = {};
    if (itens.length) {
      perfis[r.baseDomain || ""] = {
        itens,
        autoInject: r.autoInject !== false,
        autoReload: !!r.autoReload,
        intervalo: Number(r.intervalo) || 1000,
      };
    }

    chrome.storage.local.set({
      perfis,
      dominioAtual: r.baseDomain || "",
      habilitado: r.habilitado !== false,
    });
    chrome.storage.local.remove([
      "itens",
      "arquivos",
      "baseDomain",
      "autoInject",
      "autoReload",
      "intervalo",
    ]);
  });
});

function gerarId() {
  return (crypto?.randomUUID?.() || "id-" + Math.random().toString(36).slice(2)) + Date.now().toString(36);
}

function detectarTipo(str) {
  const s = (str || "").split("?")[0].split("#")[0].toLowerCase();
  if (s.endsWith(".css")) return "css";
  if (s.endsWith(".js") || s.endsWith(".mjs")) return "js";
  if (s.endsWith(".html") || s.endsWith(".htm")) return "html";
  return "";
}

function urlNoDominioBase(url, baseDomain) {
  try {
    const a = new URL(url);
    const b = new URL(baseDomain);
    return a.hostname === b.hostname && a.protocol === b.protocol;
  } catch {
    return false;
  }
}

function ehPaginaInterna(url) {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://")
  );
}

// Encontra o perfil cujo domínio corresponde à URL da aba.
function perfilParaUrl(url, perfis) {
  for (const dominio of Object.keys(perfis || {})) {
    if (dominio && urlNoDominioBase(url, dominio)) {
      return { dominio, perfil: perfis[dominio] };
    }
  }
  return null;
}

// --- Ponto único de aplicação -----------------------------------------------
function aplica(tabId, perfil, habilitado, forcar) {
  const payload = {
    itens: perfil.itens || [],
    habilitado: habilitado !== false,
    autoReload: !!perfil.autoReload,
    intervalo: Number(perfil.intervalo) || 1000,
    forcar: !!forcar,
  };
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: aplicarNaPagina,
      args: [payload],
    })
    .catch((e) => console.warn("[ext] executeScript falhou:", e.message));
}

// ============================================================================
//  Função executada DENTRO da página (deve ser autocontida).
// ============================================================================
function aplicarNaPagina(payload) {
  const MARCA = "data-ext-id";
  const itens = payload.habilitado ? payload.itens || [] : [];
  const ativos = new Set(itens.filter((i) => i.ativo).map((i) => i.id));

  // Modo forçado (aplicar manual): remove tudo antes de reinjetar.
  if (payload.forcar) {
    document.querySelectorAll("[" + MARCA + "]").forEach((el) => el.remove());
  } else {
    // Auto: remove só o que não está mais ativo.
    document.querySelectorAll("[" + MARCA + "]").forEach((el) => {
      if (!ativos.has(el.getAttribute(MARCA))) el.remove();
    });
  }

  itens.forEach((item) => {
    if (!item.ativo) return;
    const { id, tipo } = item;
    const url = item.url || "";
    if (!url) return;
    if (document.querySelector("[" + MARCA + '="' + id + '"]')) return; // já presente

    try {
      if (tipo === "css") {
        const el = document.createElement("link");
        el.rel = "stylesheet";
        el.href = url;
        el.setAttribute(MARCA, id);
        document.head.appendChild(el);
      } else if (tipo === "js") {
        const s = document.createElement("script");
        s.src = url;
        s.async = false;
        s.setAttribute(MARCA, id);
        (document.body || document.documentElement).appendChild(s);
      } else if (tipo === "html") {
        const alvo = document.querySelector(item.seletor || "body");
        if (!alvo) {
          console.warn("[ext] seletor não encontrado:", item.seletor);
          return;
        }
        const inserir = (html) => {
          const wrap = document.createElement("div");
          wrap.setAttribute(MARCA, id);
          wrap.style.display = "contents";
          wrap.innerHTML = html;
          const pos = item.posicao || "append";
          if (pos === "replace") {
            alvo.innerHTML = "";
            alvo.appendChild(wrap);
          } else if (pos === "prepend") {
            alvo.insertBefore(wrap, alvo.firstChild);
          } else {
            alvo.appendChild(wrap);
          }
        };
        chrome.runtime.sendMessage({ action: "buscar", url }, (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp && resp.texto != null) inserir(resp.texto);
        });
      }
    } catch (e) {
      console.warn("[ext] injeção falhou:", item, e);
    }
  });

  // -------- Auto-reload (watcher de arquivos servidos, ex: gulp watch) -------
  if (window.__extWatcher) {
    clearInterval(window.__extWatcher);
    window.__extWatcher = null;
  }
  if (payload.autoReload) {
    const alvos = itens
      .filter((i) => i.ativo && /^https?:/i.test(i.url || ""))
      .map((i) => ({ id: i.id, url: i.url, tipo: i.tipo }));

    if (alvos.length) {
      const sigs = {};
      // Fetch delegado ao background (evita CORS entre a página e o localhost).
      const assinar = (u) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: "buscar", url: u }, (resp) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(resp ? resp.assinatura : null);
          });
        });
      const trocarCss = (id, u) => {
        const antigos = [...document.querySelectorAll('link[' + MARCA + '="' + id + '"]')];
        const novo = document.createElement("link");
        novo.rel = "stylesheet";
        novo.href = u + (u.includes("?") ? "&" : "?") + "__ext=" + Date.now();
        novo.setAttribute(MARCA, id);
        novo.onload = () => antigos.forEach((l) => l.remove());
        document.head.appendChild(novo);
      };
      const tick = async () => {
        for (const a of alvos) {
          const s = await assinar(a.url);
          if (s == null) continue;
          if (sigs[a.url] === undefined) {
            sigs[a.url] = s;
            continue;
          }
          if (sigs[a.url] !== s) {
            sigs[a.url] = s;
            console.log("[ext] mudança detectada em", a.url);
            if (a.tipo === "css") trocarCss(a.id, a.url);
            else {
              location.reload();
              return;
            }
          }
        }
      };
      window.__extWatcher = setInterval(tick, payload.intervalo || 1000);
      tick();
    }
  }
}

// ============================================================================
//  Gatilhos
// ============================================================================

// Popup pede aplicação manual.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "aplicar") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || ehPaginaInterna(tab.url)) {
        sendResponse?.({ ok: false, motivo: "pagina-interna" });
        return;
      }
      chrome.storage.local.get(["perfis", "habilitado"], ({ perfis, habilitado }) => {
        const match = perfilParaUrl(tab.url, perfis || {});
        if (!match) {
          const temPerfis = Object.keys(perfis || {}).some((k) => k);
          sendResponse?.({ ok: false, motivo: temPerfis ? "fora-dominio" : "sem-dominio" });
          return;
        }
        aplica(tab.id, match.perfil, habilitado, msg.forcar !== false);
        sendResponse?.({ ok: true });
      });
    });
    return true; // resposta assíncrona
  }
});

// Busca um recurso a partir do background (sem CORS, usa host_permissions).
// Usado pelo watcher de auto-reload e pela injeção de HTML por URL.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "buscar") {
    buscarRecurso(msg.url)
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ texto: null, assinatura: null }));
    return true; // resposta assíncrona
  }
});

async function buscarRecurso(u) {
  const bust = u + (u.includes("?") ? "&" : "?") + "__ext=" + Date.now();
  const r = await fetch(bust, { cache: "no-store" });
  const texto = await r.text();
  let assinatura = r.headers.get("last-modified") || r.headers.get("etag");
  if (!assinatura) {
    let x = 0;
    for (let k = 0; k < texto.length; k++) x = (x * 31 + texto.charCodeAt(k)) | 0;
    assinatura = texto.length + ":" + x;
  }
  return { texto, assinatura };
}

// Reinjeta ao trocar de aba (se dentro do domínio base).
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    disparaAuto(tab.id, tab.url);
  } catch (e) {
    console.warn("[ext] onActivated:", e.message);
  }
});

// Reinjeta quando a página termina de carregar (inclui reloads do auto-reload).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    setTimeout(() => disparaAuto(tabId, tab.url), 250);
  }
});

function disparaAuto(tabId, url) {
  if (ehPaginaInterna(url)) return;
  chrome.storage.local.get(["perfis", "habilitado"], ({ perfis, habilitado }) => {
    const match = perfilParaUrl(url, perfis || {}); // busca perfil do domínio
    if (!match) return; // nenhum perfil para este site
    if (match.perfil.autoInject === false) return; // auto-inject desligado no perfil
    aplica(tabId, match.perfil, habilitado, false);
  });
}
