import { coletarRss, coletarScrape, tagsPorPalavraChave, idDe, normalizarUrl } from "./atualizar.mjs";
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
t("detecta Juros/Macro", () => assert.ok(tg2.tags_tema.includes("Juros/Macro")));
t("empresa vazia no modo keyword", () => assert.equal(tg2.tags_empresa.length, 0));

console.log("Scrape");
const html = `<html><body>
  <article><a href="/n/1"><h3>Fundo capta R$ 1 bilhão em nova rodada de fundraising</h3></a><p>Closing supera meta inicial do veículo.</p></article>
  <article><a href="https://neofeed.com.br/n/2"><h3>Startup de agtech levanta série B com investidores institucionais</h3></a></article>
  <article><a href="/n/1"><h3>Fundo capta R$ 1 bilhão em nova rodada de fundraising</h3></a></article>
</body></html>`;
const itensScrape = coletarScrape(html, { nome: "NeoFeed", url: "https://neofeed.com.br/", seletores: { item: "article" } });
t("scrape dedup por href", () => assert.equal(itensScrape.length, 2));
t("scrape resolve url relativa", () => assert.equal(itensScrape[0].url, "https://neofeed.com.br/n/1"));

console.log(`\n${ok} testes passaram.`);
