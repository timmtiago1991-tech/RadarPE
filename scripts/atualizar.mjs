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

const LIMITE_TOTAL = 800;          // teto de itens guardados (os mais recentes)
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
  const s = limparTexto(t);
  if (s.length <= RESUMO_MAX) return s;
  return s.slice(0, RESUMO_MAX).replace(/\s+\S*$/, "") + "…";
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
  "M&A", "Fundraising", "IPO/Mercado de Capitais", "Juros/Macro",
  "Private Equity", "Venture Capital", "Crédito/Dívida", "Governança",
  "Exit/Desinvestimento", "Regulação", "Agro",
];

const REGRAS_TEMA = {
  "M&A": /\b(aquisi[çc][ãa]o|adquir|fus[ãa]o|incorpora[çc][ãa]o|comprou|compra de|M&A|fus[õo]es e aquisi)/i,
  "Fundraising": /\b(capta[çc][ãa]o|captou|levantou|aporte|rodada|funding|closing|novo fundo|fundo de R\$)/i,
  "IPO/Mercado de Capitais": /\b(IPO|oferta (p[úu]blica|inicial)|follow-?on|abertura de capital|estreia na bolsa|B3\b)/i,
  "Juros/Macro": /\b(Selic|Copom|juros|IPCA|infla[çc][ãa]o|c[âa]mbio|d[óo]lar|PIB|Banco Central)/i,
  "Private Equity": /\b(private equity|gestora de|fundo de private|buyout)/i,
  "Venture Capital": /\b(venture capital|\bVC\b|startup|early[- ]stage|s[ée]rie [A-E]\b)/i,
  "Crédito/Dívida": /\b(deb[êe]nture|CRI\b|CRA\b|CDB|d[íi]vida|bond|emiss[ãa]o de|recupera[çc][ãa]o judicial)/i,
  "Governança": /\b(conselho|governan[çc]a|CEO|CFO|acionistas|assembleia)/i,
  "Exit/Desinvestimento": /\b(desinvest|venda de participa|sa[íi]da do fundo|exit\b|alien[aou])/i,
  "Regulação": /\b(CVM|CADE|Anbima|regula|BACEN|marco legal)/i,
  "Agro": /\b(agro|agroneg[óo]cio|safra|fertilizante|commodit|pecu[áa]ria|gr[ãa]os)/i,
};

export function tagsPorPalavraChave(item) {
  const texto = `${item.manchete} ${item.resumo}`;
  const temas = [];
  for (const [tema, re] of Object.entries(REGRAS_TEMA)) {
    if (re.test(texto)) temas.push(tema);
  }
  // company tags por palavra-chave sao pouco confiaveis -> ficam vazias no modo keyword
  return { tags_tema: temas.slice(0, 4), tags_empresa: [] };
}

async function tagsPorLLM(item) {
  const key = process.env.ANTHROPIC_API_KEY;
  const prompt =
    `Voce classifica noticias de negocios/PE no Brasil.\n` +
    `TEMAS permitidos (use apenas estes, 0 a 4): ${TEMAS_PERMITIDOS.join(", ")}.\n` +
    `EMPRESAS: extraia nomes de empresas/gestoras/fundos citados (0 a 5). Nomes proprios, sem generico.\n` +
    `Responda SOMENTE JSON valido, sem markdown: {"tags_tema":[],"tags_empresa":[]}\n\n` +
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
  const limpo = txt.replace(/```json|```/g, "").trim();
  const obj = JSON.parse(limpo);
  return {
    tags_tema: (obj.tags_tema || []).filter((t) => TEMAS_PERMITIDOS.includes(t)).slice(0, 4),
    tags_empresa: (obj.tags_empresa || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5),
  };
}

async function gerarTags(item, usarLLM) {
  if (usarLLM) {
    try {
      return await tagsPorLLM(item);
    } catch (e) {
      console.warn(`  ! tag LLM falhou (${e.message}); usando palavra-chave`);
    }
  }
  return tagsPorPalavraChave(item);
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

  const novos = [];
  for (const fonte of fontes) {
    try {
      console.log(`\n> ${fonte.nome} (${fonte.metodo})`);
      const conteudo = await baixar(fonte.url);
      const brutos = fonte.metodo === "rss" ? coletarRss(conteudo, fonte) : coletarScrape(conteudo, fonte);
      console.log(`  ${brutos.length} itens coletados`);

      for (const it of brutos) {
        const id = idDe(it.url);
        if (idsExistentes.has(id)) continue;
        idsExistentes.add(id);
        const tags = await gerarTags(it, usarLLM);
        novos.push({ id, ...it, url: it.url, ...tags });
      }
    } catch (e) {
      console.error(`  X falha em ${fonte.nome}: ${e.message}`);
    }
  }

  console.log(`\n${novos.length} novos itens no total`);

  const todos = [...novos, ...existentes]
    .sort((a, b) => new Date(b.data) - new Date(a.data))
    .slice(0, LIMITE_TOTAL);

  await writeFile(CAMINHO_DADOS, JSON.stringify(todos, null, 2) + "\n", "utf8");
  console.log(`Gravado ${todos.length} itens em dados/noticias.json`);
}

const executadoDireto = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
