// atualizar.mjs
// Busca noticias (RSS ou scrape), remove duplicados, gera tags e grava dados/noticias.json.
// Roda no GitHub Actions (Node 20+). Sem dependencia de servico externo alem da API opcional de tags.

import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname, "..");
const CAMINHO_FONTES = resolve(RAIZ, "fontes.json");
const CAMINHO_DADOS = resolve(RAIZ, "dados", "noticias.json");
const CAMINHO_DESCARTADOS = resolve(RAIZ, "dados", "descartados.json");
const CAMINHO_CONFIG = resolve(RAIZ, "config.json");
const CAMINHO_INDICACOES = resolve(RAIZ, "dados", "indicacoes.json");

const LIMITE_TOTAL = 800;          // teto de itens guardados (os mais recentes)
const LIMITE_DESCARTADOS = 3000;   // teto do registro de descartados (so id/titulo/data)
const RESUMO_MAX = 320;            // corte do resumo em caracteres

// ---------- utilitarios ----------

export function normalizarUrl(u) {
  try {
    const url = new URL(u);
    // remove parametros de tracking
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref)/i.test(p)) url.searchParams.delete(p);
    }
    url.hash = "";
    let s = url.toString();
    return s.replace(/\/$/, "");
  } catch {
    return (u || "").trim();
  }
}

export function idDe(url) {
  return createHash("sha1").update(normalizarUrl(url)).digest("hex").slice(0, 16);
}

function limparTexto(html = "") {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cortarResumo(t = "") {
  let s = limparTexto(t)
    .replace(/\bThe post\b.*?\bappeared first on\b.*$/i, "")
    .replace(/\bO post\b.*?\bapareceu primeiro\b.*$/i, "")
    .replace(/\s*(\[\u2026\]|\[\.\.\.\]|Leia mais|Continue lendo|Read more|Continue reading|Saiba mais)\s*\.?\s*$/i, "")
    .trim();
  if (s.length <= RESUMO_MAX) return s;
  return s.slice(0, RESUMO_MAX).replace(/\s+\S*$/, "") + "…";
}

// listas de exclusao: publicidade, paginas de autor/tema, navegacao, seed antigo
const EXCLUIR_URL_GLOBAL = [
  "/brand-stories/", "/autor/", "/noticias-sobre/", "/tag/", "/categoria/",
  "apresentado-por", "patrocinado", "publieditorial", "publicidade", "/branded",
  "exemplo.com.br",
];

function urlPermitida(url, extras = []) {
  const u = (url || "").toLowerCase();
  return ![...EXCLUIR_URL_GLOBAL, ...extras].some((p) => u.includes(p.toLowerCase()));
}

// heuristica p/ scrape: materia real tem >=2 segmentos e slug longo (>=2 hifens);
// derruba paginas de nav/autor/tema que escapem da denylist
function pareceArtigo(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (segs.length < 2) return false;
    const slug = segs[segs.length - 1];
    return (slug.match(/-/g) || []).length >= 2;
  } catch {
    return false;
  }
}

async function baixar(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; PEFeedBot/1.0; +https://github.com)",
      Accept: "application/rss+xml, application/xml, text/html;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
  return await resp.text();
}

// le a meta-descricao da pagina do artigo (og:description / description)
export function extrairDescricao(html) {
  const $ = cheerio.load(html);
  const desc =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    $('meta[name="twitter:description"]').attr("content") ||
    "";
  return cortarResumo(desc);
}

async function buscarResumoArtigo(url) {
  try {
    return extrairDescricao(await baixar(url));
  } catch {
    return "";
  }
}

// para indicacoes: titulo da materia (og:title / <title>) ou, se bloqueada, palavras da URL
export function extrairTitulo(html) {
  const $ = cheerio.load(html);
  return limparTexto($('meta[property="og:title"]').attr("content") || $("title").first().text() || "");
}

export function deSlug(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const base = segs[segs.length - 1] || u.hostname;
    return base.replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return url;
  }
}

async function resolverTitulo(url) {
  try {
    const t = extrairTitulo(await baixar(url));
    if (t && t.length > 6) return t.slice(0, 160);
  } catch { /* pagina inacessivel */ }
  return deSlug(url);
}

// ---------- coletores ----------

export function coletarRss(xml, fonte) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml);
  const canal = doc?.rss?.channel ?? doc?.feed ?? {};
  let itens = canal.item ?? canal.entry ?? [];
  if (!Array.isArray(itens)) itens = [itens];

  return itens
    .map((it) => {
      // RSS 2.0 e Atom
      let link = it.link;
      if (typeof link === "object") link = link["@_href"] ?? link["#text"] ?? "";
      const titulo = limparTexto(it.title?.["#text"] ?? it.title ?? "");
      const resumo = cortarResumo(
        it.description ?? it.summary?.["#text"] ?? it.summary ?? it["content:encoded"] ?? ""
      );
      const dataStr = it.pubDate ?? it.published ?? it.updated ?? it["dc:date"] ?? null;
      const data = dataStr ? new Date(dataStr) : new Date();
      return { manchete: titulo, url: String(link || "").trim(), resumo, fonte: fonte.nome, data: data.toISOString() };
    })
    .filter((x) => x.manchete && x.url);
}

export function coletarScrape(html, fonte) {
  const $ = cheerio.load(html);
  const sel = fonte.seletores ?? {};
  const cards = $(sel.item || "article");
  const vistos = new Set();
  const out = [];

  cards.each((_, el) => {
    const $el = $(el);
    const $link = sel.link ? $el.find(sel.link).first() : ($el.is("a") ? $el : $el.find("a").first());
    let href = $link.attr("href") || $el.attr("href") || "";
    if (!href) return;
    try { href = new URL(href, fonte.url).toString(); } catch { return; }
    if (!urlPermitida(href, fonte.excluir_url)) return;   // fora: publicidade/autor/tema
    if (!pareceArtigo(href)) return;                       // fora: nav/paginas curtas

    const titulo = limparTexto(
      sel.titulo ? $el.find(sel.titulo).first().text() : ($link.text() || $el.find("h1,h2,h3").first().text())
    );
    if (!titulo || titulo.length < 12) return;
    if (vistos.has(href)) return;
    vistos.add(href);

    const resumo = cortarResumo(sel.resumo ? $el.find(sel.resumo).first().text() : $el.find("p").first().text());
    out.push({ manchete: titulo, url: href, resumo, fonte: fonte.nome, data: new Date().toISOString() });
  });

  return out;
}

// ---------- tagging ----------

const TEMAS_PERMITIDOS = [
  "Private Equity", "Venture Capital", "M&A", "Dívida/Debêntures",
  "Curva de Juros", "Economia Real", "RJ/EJ", "Fundraising",
  "IPO/Mercado de Capitais", "Regulação",
];

const REGRAS_TEMA = {
  "M&A": /\b(aquisi[çc][ãa]o|adquir|fus[ãa]o|incorpora[çc][ãa]o|comprou|compra de|M&A|fus[õo]es e aquisi)/i,
  "Private Equity": /\b(private equity|gestora de|fundo de private|buyout|participa[çc][ãa]o)/i,
  "Venture Capital": /\b(venture capital|\bVC\b|startup|early[- ]stage|s[ée]rie [A-E]\b|rodada)/i,
  "Dívida/Debêntures": /\b(deb[êe]nture|CRI\b|CRA\b|CDB|emiss[ãa]o de d[íi]vida|emiss[ãa]o de|bond|nota promiss[óo]ria|capta[çc][ãa]o via d[íi]vida)/i,
  "Curva de Juros": /\b(Selic|Copom|curva de juros|juros futur|taxa b[áa]sica|\bDI\b|Treasury|yield)/i,
  "Economia Real": /\b(desemprego|emprego|\bPIB\b|infla[çc][ãa]o|IPCA|endividamento|inadimpl[êe]ncia|renda|varejo|atividade econ|produ[çc][ãa]o industrial|Caged)/i,
  "RJ/EJ": /\b(recupera[çc][ãa]o judicial|recupera[çc][ãa]o extrajudicial|\bRJ\b|fal[êe]ncia|reestrutura[çc][ãa]o de d[íi]vida)/i,
  "Fundraising": /\b(capta[çc][ãa]o|captou|levantou|aporte|funding|closing|novo fundo|fundo de R\$)/i,
  "IPO/Mercado de Capitais": /\b(IPO|oferta (p[úu]blica|inicial)|follow-?on|abertura de capital|estreia na bolsa|B3\b)/i,
  "Regulação": /\b(CVM|CADE|Anbima|BACEN|Banco Central|regula|marco legal)/i,
};

export function normalizarTags(obj = {}) {
  let imp = Number.isFinite(obj.importancia) ? Math.round(obj.importancia) : 3;
  imp = Math.max(0, Math.min(5, imp));
  return {
    tags_tema: (obj.tags_tema || []).filter((t) => TEMAS_PERMITIDOS.includes(t)).slice(0, 4),
    tags_empresa: (obj.tags_empresa || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5),
    relevante: obj.relevante !== false,   // default: relevante, salvo se o modelo disser false
    importancia: imp,                     // 0-5, default 3
  };
}

export function tagsPorPalavraChave(item) {
  const texto = `${item.manchete} ${item.resumo}`;
  const temas = [];
  for (const [tema, re] of Object.entries(REGRAS_TEMA)) {
    if (re.test(texto)) temas.push(tema);
  }
  // modo palavra-chave nao julga relevancia nem extrai empresas de forma confiavel
  return { tags_tema: temas.slice(0, 4), tags_empresa: [], relevante: true, importancia: 3 };
}

async function tagsPorLLM(item, exemplos = "") {
  const key = process.env.ANTHROPIC_API_KEY;
  const prompt =
    `Você classifica notícias para um feed de private equity no Brasil.\n\n` +
    `RELEVÂNCIA — o padrão é MANTER. Marque "relevante": true sempre que a notícia tiver qualquer ligação com negócios, finanças, economia, mercado de capitais ou empresas, mesmo que indireta. Inclui, além de deals: movimentos de bolsa/Ibovespa, câmbio, juros, dados macro e de economia real, agro econômico e do agronegócio, regulação, planos de investimento/expansão de empresas, resultados e reestruturações.\n` +
    `Marque "relevante": false APENAS quando a notícia claramente não tiver ângulo econômico/empresarial — como cultura, esporte, entretenimento, celebridades, clima/tragédias sem impacto econômico direto, tecnologia de consumo ou crime comum. Na dúvida, MANTENHA (true).\n\n` +
    `TEMAS — use apenas destes, de 0 a 4, só quando encaixarem bem (pode ficar vazio e ainda assim ser relevante): ${TEMAS_PERMITIDOS.join("; ")}.\n` +
    `EMPRESAS — nomes próprios de empresas/gestoras/fundos citados (0 a 5), sem termos genéricos.\n` +
    `IMPORTÂNCIA — inteiro de 0 a 5: quão central a notícia é para um investidor de private equity (5 = deal/PE/M&A/captação direto; 3 = mercado/economia relevante; 0 = tangencial).\n` +
    (exemplos ? exemplos + `Os exemplos acima são referência do gosto do grupo, não regra absoluta; na dúvida, prefira manter.\n` : "") +
    `Responda SOMENTE JSON válido, sem markdown: {"relevante":true,"importancia":3,"tags_tema":[],"tags_empresa":[]}\n\n` +
    `Manchete: ${item.manchete}\nResumo: ${item.resumo}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`API tags HTTP ${resp.status}`);
  const data = await resp.json();
  const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const obj = JSON.parse(txt.replace(/```json|```/g, "").trim());
  return normalizarTags(obj);
}

async function gerarTags(item, usarLLM, exemplos = "") {
  if (usarLLM) {
    try {
      return await tagsPorLLM(item, exemplos);
    } catch (e) {
      console.warn(`  ! tag LLM falhou (${e.message}); usando palavra-chave`);
    }
  }
  return tagsPorPalavraChave(item);
}

// ---------- feedback dos leitores (votos no Firebase) ----------

async function lerVotos(dbUrl) {
  try {
    const resp = await fetch(`${dbUrl}/votos.json`);
    if (!resp.ok) return {};
    const data = (await resp.json()) || {};
    const agg = {};
    for (const [id, recs] of Object.entries(data)) {
      let rel = 0, irr = 0;
      for (const k in recs) {
        const v = recs[k] && recs[k].v;
        if (v > 0) rel++; else if (v < 0) irr++;
      }
      agg[id] = { rel, irr };
    }
    return agg;
  } catch (e) {
    console.warn(`  ! leitura de votos falhou: ${e.message}`);
    return {};
  }
}

async function lerIndicacoes(dbUrl) {
  try {
    const resp = await fetch(`${dbUrl}/indicacoes.json`);
    if (!resp.ok) return [];
    const data = (await resp.json()) || {};
    return Object.values(data).map((x) => x && x.url).filter(Boolean);
  } catch (e) {
    console.warn(`  ! leitura de indicacoes falhou: ${e.message}`);
    return [];
  }
}

export function montarExemplos(agg, mapaTitulos, extrasRelevantes = [], limite = 6) {
  const rel = [], irr = [];
  for (const [id, v] of Object.entries(agg)) {
    const t = mapaTitulos.get(id);
    if (!t) continue;
    if (v.rel > v.irr) rel.push({ t, n: v.rel - v.irr });
    else if (v.irr > v.rel) irr.push({ t, n: v.irr - v.rel });
  }
  for (const t of extrasRelevantes) if (t) rel.push({ t, n: 999 }); // indicacao = sinal forte
  rel.sort((a, b) => b.n - a.n);
  irr.sort((a, b) => b.n - a.n);
  if (!rel.length && !irr.length) return "";
  let s = `\nEXEMPLOS rotulados pelos leitores (referencia do gosto do grupo):\n`;
  if (rel.length) s += `Relevantes:\n${rel.slice(0, limite).map((x) => `- ${x.t}`).join("\n")}\n`;
  if (irr.length) s += `Fora de tema:\n${irr.slice(0, limite).map((x) => `- ${x.t}`).join("\n")}\n`;
  return s + "\n";
}

// ---------- principal ----------

async function main() {
  const fontes = JSON.parse(await readFile(CAMINHO_FONTES, "utf8"));

  let existentes = [];
  try {
    existentes = JSON.parse(await readFile(CAMINHO_DADOS, "utf8"));
  } catch {
    existentes = [];
  }
  const idsExistentes = new Set(existentes.map((x) => x.id));
  const usarLLM = !!process.env.ANTHROPIC_API_KEY;
  console.log(`Modo de tags: ${usarLLM ? "LLM (Claude)" : "palavra-chave"}`);

  // registro de descartados: so {id, manchete, data} — evita re-julgar a mesma URL
  let descartados = [];
  try {
    descartados = JSON.parse(await readFile(CAMINHO_DESCARTADOS, "utf8"));
  } catch {
    descartados = [];
  }
  const idsDescartados = new Set(descartados.map((x) => x.id));

  // feedback: le votos do Firebase (se configurado) e monta exemplos p/ o prompt
  let exemplos = "";
  try {
    const cfg = JSON.parse(await readFile(CAMINHO_CONFIG, "utf8"));
    const dbUrl = (cfg.firebaseDbUrl || "").replace(/\/+$/, "");
    if (dbUrl && usarLLM) {
      const agg = await lerVotos(dbUrl);
      const mapa = new Map();
      for (const x of existentes) mapa.set(x.id, x.manchete);
      for (const x of descartados) mapa.set(x.id, x.manchete);

      // indicacoes de materia (treino apenas): resolve titulo e guarda no ledger local
      let extras = [];
      const urls = await lerIndicacoes(dbUrl);
      if (urls.length) {
        let ledger = [];
        try { ledger = JSON.parse(await readFile(CAMINHO_INDICACOES, "utf8")); } catch { ledger = []; }
        const conhecidas = new Set(ledger.map((x) => x.url));
        let add = 0;
        for (const u of urls) {
          if (conhecidas.has(u)) continue;
          conhecidas.add(u);
          ledger.push({ url: u, titulo: await resolverTitulo(u), t: Date.now() });
          add++;
        }
        ledger = ledger.slice(-200);
        await writeFile(CAMINHO_INDICACOES, JSON.stringify(ledger, null, 2) + "\n", "utf8");
        if (add) console.log(`Indicações: ${add} nova(s) processada(s) para treino`);
        extras = ledger.slice(-12).map((x) => x.titulo);
      }

      exemplos = montarExemplos(agg, mapa, extras);
      const n = Object.keys(agg).length;
      if (n || extras.length) console.log(`Feedback: ${n} votada(s) + ${extras.length} indicada(s) aplicadas ao filtro`);
    }
  } catch { /* sem config = feedback desligado */ }

  const novos = [];
  for (const fonte of fontes) {
    try {
      console.log(`\n> ${fonte.nome} (${fonte.metodo})`);
      const conteudo = await baixar(fonte.url);
      const brutos = fonte.metodo === "rss" ? coletarRss(conteudo, fonte) : coletarScrape(conteudo, fonte);
      console.log(`  ${brutos.length} itens coletados`);

      for (const it of brutos) {
        if (!urlPermitida(it.url, fonte.excluir_url)) continue;
        const id = idDe(it.url);
        if (idsExistentes.has(id) || idsDescartados.has(id)) continue;   // ja no feed ou ja descartado
        idsExistentes.add(id);
        if (!it.resumo || it.resumo.length < 30) {
          const d = await buscarResumoArtigo(it.url);   // abre a materia e pega a meta-descricao
          if (d) it.resumo = d;
        }
        const tags = await gerarTags(it, usarLLM, exemplos);
        if (tags.relevante === false) {
          // fora de tema: guarda so a impressao digital, nao entra no feed
          descartados.push({ id, manchete: it.manchete, data: it.data });
          idsDescartados.add(id);
          continue;
        }
        novos.push({ id, ...it, url: it.url, ...tags });
      }
    } catch (e) {
      console.error(`  X falha em ${fonte.nome}: ${e.message}`);
    }
  }

  console.log(`\n${novos.length} novos itens coletados`);

  const antes = existentes.length;
  const base = [...novos, ...existentes].filter((x) => urlPermitida(x.url));
  const purgados = existentes.filter((x) => !urlPermitida(x.url)).length;
  if (purgados) console.log(`Limpeza: ${purgados} item(ns) antigos removidos (URL/publicidade/seed)`);

  // backfill capado (30/execucao): resumo faltante + (re)avaliacao de relevancia/tags
  // em itens antigos que ainda nao tem veredito. Assim a taxonomia nova vale para a base velha.
  let orcamento = 30, resumoAdd = 0, reavaliados = 0;
  for (const x of base) {
    if (orcamento <= 0) break;
    let mexeu = false;
    if ((!x.resumo || x.resumo.length < 30) && !x.url.includes("exemplo.com.br")) {
      const d = await buscarResumoArtigo(x.url);
      if (d) { x.resumo = d; resumoAdd++; mexeu = true; }
    }
    if (usarLLM && (x.relevante === undefined || x.importancia === undefined)) {
      const t = await gerarTags(x, true, exemplos);
      x.tags_tema = t.tags_tema; x.tags_empresa = t.tags_empresa; x.relevante = t.relevante; x.importancia = t.importancia;
      reavaliados++; mexeu = true;
    }
    if (mexeu) orcamento--;
  }
  if (resumoAdd) console.log(`Resumo preenchido em ${resumoAdd} item(ns) antigos`);
  if (reavaliados) console.log(`Relevancia/tags reavaliadas em ${reavaliados} item(ns) antigos`);

  // separa: feed = so relevante; irrelevantes viram impressao digital no ledger
  const relevantes = [];
  for (const x of base) {
    if (x.relevante === false) {
      if (!idsDescartados.has(x.id)) {
        descartados.push({ id: x.id, manchete: x.manchete, data: x.data });
        idsDescartados.add(x.id);
      }
    } else {
      relevantes.push(x);
    }
  }
  const movidos = base.length - relevantes.length;
  if (usarLLM && movidos) console.log(`${movidos} item(ns) fora de tema movidos para o registro de descartados`);

  const ordenados = relevantes.sort((a, b) => new Date(b.data) - new Date(a.data));

  // teto do AgFeed: no maximo ~10% do total do feed, mantendo os mais importantes
  const ag = ordenados.filter((x) => x.fonte === "AgFeed");
  const resto = ordenados.filter((x) => x.fonte !== "AgFeed");
  const agMax = Math.max(1, Math.round(resto.length / 9));   // ag = 10% de (resto+ag)
  const agMantido = [...ag]
    .sort((a, b) => (b.importancia ?? 3) - (a.importancia ?? 3) || new Date(b.data) - new Date(a.data))
    .slice(0, agMax);
  if (ag.length > agMantido.length) {
    console.log(`Teto AgFeed: ${ag.length} -> ${agMantido.length} (max 10% do feed, por importancia)`);
  }

  const todos = [...resto, ...agMantido]
    .sort((a, b) => new Date(b.data) - new Date(a.data))
    .slice(0, LIMITE_TOTAL);

  // poda o ledger de descartados (mantem os mais recentes)
  const ledger = descartados
    .sort((a, b) => new Date(b.data) - new Date(a.data))
    .slice(0, LIMITE_DESCARTADOS);

  await writeFile(CAMINHO_DADOS, JSON.stringify(todos, null, 2) + "\n", "utf8");
  await writeFile(CAMINHO_DESCARTADOS, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  console.log(`Gravado ${todos.length} itens em noticias.json | ${ledger.length} no registro de descartados`);
}

const executadoDireto = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
