import { coletarRss, coletarScrape, tagsPorPalavraChave, idDe, normalizarUrl, extrairDescricao, normalizarTags, montarExemplos } from "./atualizar.mjs";
import assert from "node:assert";

let ok = 0;
const t = (nome, fn) => { fn(); ok++; console.log("  ✓", nome); };

console.log("RSS");
const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Fonte X</title>
<item>
  <title>Gestora anuncia aquisição de rival por 9x EV/EBITDA</title>
  <link>https://ex.com/deal?utm_source=rss&amp;id=1</link>
  <description><![CDATA[<p>A <b>compra</b> reforça a consolidação do setor.</p>]]></description>
  <pubDate>Tue, 01 Jul 2026 11:00:00 GMT</pubDate>
</item>
<item>
  <title>Copom mantém Selic e mercado avalia impacto nos juros</title>
  <link>https://ex.com/selic</link>
  <description>Decisão em linha com consenso sobre inflação e IPCA.</description>
  <pubDate>Mon, 30 Jun 2026 21:00:00 GMT</pubDate>
</item>
</channel></rss>`;

const itensRss = coletarRss(rss, { nome: "Fonte X" });
t("extrai 2 itens", () => assert.equal(itensRss.length, 2));
t("titulo limpo", () => assert.match(itensRss[0].manchete, /aquisição de rival/));
t("resumo sem HTML", () => assert.ok(!/[<>]/.test(itensRss[0].resumo)));
t("data ISO", () => assert.match(itensRss[0].data, /2026-07-01T11:00/));
t("fonte preenchida", () => assert.equal(itensRss[0].fonte, "Fonte X"));

console.log("URL / dedup");
t("remove utm", () => assert.equal(normalizarUrl("https://ex.com/deal?utm_source=rss&id=1"), "https://ex.com/deal?id=1"));
t("id estável", () => assert.equal(
  idDe("https://ex.com/deal?utm_source=rss&id=1"),
  idDe("https://ex.com/deal?id=1&fbclid=abc")
));

console.log("Tags por palavra-chave");
const tg1 = tagsPorPalavraChave(itensRss[0]);
t("detecta M&A", () => assert.ok(tg1.tags_tema.includes("M&A")));
const tg2 = tagsPorPalavraChave(itensRss[1]);
t("detecta Curva de Juros", () => assert.ok(tg2.tags_tema.includes("Curva de Juros")));
t("keyword marca relevante=true", () => assert.equal(tg2.relevante, true));
t("empresa vazia no modo keyword", () => assert.equal(tg2.tags_empresa.length, 0));

console.log("Normalizador de tags (LLM)");
t("filtra tema fora da taxonomia", () =>
  assert.deepEqual(normalizarTags({ tags_tema: ["M&A", "Fofoca"], relevante: true }).tags_tema, ["M&A"]));
t("relevante=false é respeitado", () =>
  assert.equal(normalizarTags({ relevante: false }).relevante, false));
t("relevante ausente vira true", () =>
  assert.equal(normalizarTags({ tags_tema: [] }).relevante, true));
t("limita empresas a 5", () =>
  assert.equal(normalizarTags({ tags_empresa: ["a","b","c","d","e","f"] }).tags_empresa.length, 5));

console.log("Scrape");
const html = `<html><body>
  <article><a href="/negocios/fundo-capta-r-1-bilhao-em-nova-rodada-de-fundraising"><h3>Fundo capta R$ 1 bilhão em nova rodada de fundraising</h3></a><p>Closing supera meta inicial do veículo.</p></article>
  <article><a href="https://neofeed.com.br/startups/startup-de-agtech-levanta-serie-b-com-investidores"><h3>Startup de agtech levanta série B com investidores institucionais</h3></a></article>
  <article><a href="/negocios/fundo-capta-r-1-bilhao-em-nova-rodada-de-fundraising"><h3>Fundo capta R$ 1 bilhão em nova rodada de fundraising</h3></a></article>
  <article><a href="/brand-stories/apresentado-por-itau/como-o-itau-acelera"><h3>Apresentado por Itaú: como o banco acelera empresas</h3></a></article>
  <article><a href="/autor/joao-silva"><h3>João Silva, jornalista da editoria de negócios</h3></a></article>
</body></html>`;
const itensScrape = coletarScrape(html, { nome: "NeoFeed", url: "https://neofeed.com.br/", seletores: { item: "article" } });
t("scrape mantém só as 2 matérias reais", () => assert.equal(itensScrape.length, 2));
t("scrape dropa publicidade (brand-stories)", () => assert.ok(!itensScrape.some((x) => x.url.includes("brand-stories"))));
t("scrape dropa página de autor", () => assert.ok(!itensScrape.some((x) => x.url.includes("/autor/"))));
t("scrape resolve url relativa", () => assert.ok(itensScrape[0].url.startsWith("https://neofeed.com.br/negocios/")));

console.log("Resumo / meta-descrição");
const rssBoiler = `<?xml version="1.0"?><rss version="2.0"><channel><item>
  <title>Teste boilerplate</title><link>https://ex.com/x</link>
  <description>Milhares perderam suas casas nos tremores. The post Número de mortos appeared first on InfoMoney.</description>
  <pubDate>Tue, 01 Jul 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
const bo = coletarRss(rssBoiler, { nome: "InfoMoney" })[0];
t("remove 'The post ... appeared first on'", () => assert.ok(!/appeared first on/i.test(bo.resumo)));
t("mantém o texto útil do resumo", () => assert.match(bo.resumo, /tremores/));

const pagina = `<html><head>
  <meta property="og:description" content="Gestora anuncia captação de R$ 1 bi para fundo de infraestrutura, superando a meta." />
</head><body>...</body></html>`;
t("extrai og:description da página", () => assert.match(extrairDescricao(pagina), /captação de R\$ 1 bi/));

console.log("Feedback (exemplos a partir de votos)");
const mapa = new Map([["id1", "Gestora capta fundo bilionário"], ["id2", "Resenha de filme de terror"], ["id3", "Coluna sobre viagens"]]);
const agg = { id1: { rel: 3, irr: 0 }, id2: { rel: 0, irr: 2 }, id3: { rel: 1, irr: 1 } };
const ex = montarExemplos(agg, mapa);
t("inclui exemplo relevante votado", () => assert.match(ex, /Gestora capta fundo bilionário/));
t("inclui exemplo fora de tema votado", () => assert.match(ex, /Resenha de filme de terror/));
t("empate não vira exemplo", () => assert.ok(!ex.includes("viagens")));
t("sem votos = string vazia", () => assert.equal(montarExemplos({}, mapa), ""));

console.log(`\n${ok} testes passaram.`);
