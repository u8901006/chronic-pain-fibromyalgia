#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const HEADERS = { "User-Agent": "ChronicPainBot/1.0 (research aggregator)" };

const SEARCH_QUERIES = [
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab] OR "fibromyalgia syndrome"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Chronic Pain"[Mesh] OR "chronic pain"[tiab] OR nociplastic[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("central sensitization"[tiab] OR "pain modulation"[tiab] OR "descending inhibition"[tiab] OR neuroinflammation[tiab] OR "functional connectivity"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Magnetic Resonance Imaging"[Mesh] OR fMRI[tiab] OR "functional connectivity"[tiab] OR "brain network*"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Depression"[Mesh] OR "Anxiety"[Mesh] OR catastrophizing[tiab] OR trauma[tiab] OR PTSD[tiab] OR "pain acceptance"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND (sleep[tiab] OR insomnia[tiab] OR fatigue[tiab] OR "cognitive dysfunction"[tiab] OR "fibro fog"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Rehabilitation"[Mesh] OR exercise[tiab] OR "aerobic exercise"[tiab] OR "resistance training"[tiab] OR "aquatic therapy"[tiab] OR pacing[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Cognitive Behavioral Therapy"[Mesh] OR CBT[tiab] OR ACT[tiab] OR mindfulness[tiab] OR psychoeducation[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND (stigma[tiab] OR "social support"[tiab] OR "work disability"[tiab] OR "healthcare utilization"[tiab] OR qualitative[tiab] OR "lived experience"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND (cytokines[tiab] OR biomarker*[tiab] OR "small fiber neuropathy"[tiab] OR mitochondria[tiab] OR microcirculation[tiab] OR serotonin[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND ("Transcranial Magnetic Stimulation"[Mesh] OR rTMS[tiab] OR TMS[tiab] OR "repetitive transcranial magnetic stimulation"[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND (tDCS[tiab] OR "transcranial direct current stimulation"[tiab] OR neuromodulation[tiab] OR "motor cortex"[tiab] OR DLPFC[tiab])`,
  `("Fibromyalgia"[Mesh] OR fibromyalgia[tiab]) AND (guideline[tiab] OR consensus[tiab] OR "systematic review"[tiab] OR "meta-analysis"[pt])`,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: "papers.json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") opts.days = parseInt(args[++i]);
    else if (args[i] === "--max-papers") opts.maxPapers = parseInt(args[++i]);
    else if (args[i] === "--output") opts.output = args[++i];
  }
  return opts;
}

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const lookback = d.toISOString().slice(0, 10).replace(/-/g, "/");
  return `"${lookback}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(query, retmax = 50) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(",");
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const xml = await resp.text();
    return parseXmlPapers(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXmlPapers(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    try {
      const title = extractTag(block, "ArticleTitle") || "";
      const abstractParts = [];
      const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let absMatch;
      while ((absMatch = absRegex.exec(block)) !== null) {
        const label = (absMatch[0].match(/Label="([^"]*)"/) || [])[1] || "";
        const text = stripTags(absMatch[1]).trim();
        if (label && text) abstractParts.push(`${label}: ${text}`);
        else if (text) abstractParts.push(text);
      }
      const abstract = abstractParts.join(" ").slice(0, 2000);
      const journal = extractTag(block, "<Title>") || extractTag(block, "Title") || "";
      const year = extractTag(block, "Year") || "";
      const month = extractTag(block, "Month") || "";
      const day = extractTag(block, "Day") || "";
      const dateStr = [year, month, day].filter(Boolean).join(" ");
      const pmid = extractTag(block, "PMID") || "";
      const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";
      const keywords = [];
      const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
      let kwMatch;
      while ((kwMatch = kwRegex.exec(block)) !== null) {
        const kw = kwMatch[1].trim();
        if (kw) keywords.push(kw);
      }
      if (title) {
        papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
      }
    } catch (e) {
      continue;
    }
  }
  return papers;
}

function extractTag(xml, tag) {
  const openTag = tag.startsWith("<") ? tag : `<${tag}>`;
  const closeTag = tag.startsWith("<") ? tag.replace("<", "</") : `</${tag}>`;
  const regex = new RegExp(`${escapeRegex(openTag)}([\\s\\S]*?)${escapeRegex(closeTag)}`);
  const match = xml.match(regex);
  return match ? stripTags(match[1]).trim() : "";
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, "");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadSeenPmids() {
  const path = resolve("docs/seen_pmids.json");
  if (existsSync(path)) {
    try {
      return new Set(JSON.parse(readFileSync(path, "utf-8")));
    } catch {
      return new Set();
    }
  }
  const docsDir = resolve("docs");
  if (!existsSync(docsDir)) return new Set();
  const seen = new Set();
  const files = readdirSync(docsDir).filter((f) => f.startsWith("chronic-pain-") && f.endsWith(".html"));
  for (const f of files) {
    try {
      const html = readFileSync(join(docsDir, f), "utf-8");
      const pmidRegex = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g;
      let m;
      while ((m = pmidRegex.exec(html)) !== null) seen.add(m[1]);
    } catch { continue; }
  }
  return seen;
}

function saveSeenPmids(seen) {
  const path = resolve("docs/seen_pmids.json");
  writeFileSync(path, JSON.stringify([...seen], null, 2), "utf-8");
}

async function main() {
  const opts = parseArgs();
  const dateFilter = buildDateFilter(opts.days);
  console.error(`[INFO] Searching PubMed for papers from last ${opts.days} days...`);

  const allPmids = new Set();
  for (const query of SEARCH_QUERIES) {
    const fullQuery = `${query} AND ${dateFilter}`;
    const pmids = await searchPapers(fullQuery, 20);
    pmids.forEach((id) => allPmids.add(id));
  }
  console.error(`[INFO] Found ${allPmids.size} unique PMIDs`);

  if (allPmids.size === 0) {
    const output = { date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }), count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No papers found");
    return;
  }

  const seenPmids = loadSeenPmids();
  const newPmids = [...allPmids].filter((id) => !seenPmids.has(id));
  console.error(`[INFO] After dedup: ${newPmids.length} new papers (seen: ${seenPmids.size})`);

  if (newPmids.length === 0) {
    const output = { date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }), count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No new papers after dedup");
    return;
  }

  const pmidsToFetch = newPmids.slice(0, opts.maxPapers);
  const papers = await fetchDetails(pmidsToFetch);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  newPmids.forEach((id) => seenPmids.add(id));
  saveSeenPmids(seenPmids);

  const output = {
    date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
    count: papers.length,
    papers,
  };
  writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
