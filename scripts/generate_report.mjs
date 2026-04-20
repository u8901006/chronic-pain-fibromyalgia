#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS = ["GLM-5-Turbo", "GLM-4.7", "GLM-4.7-Flash"];
const MAX_TOKENS = 100000;
const TIMEOUT_MS = 660000;

const SYSTEM_PROMPT = `你是纖維肌痛症（fibromyalgia）與慢性疼痛領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）

回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const TAG_OPTIONS = [
  "纖維肌痛症", "慢性疼痛", "中樞敏感化", "疼痛機制", "神經影像",
  "神經調節", "rTMS", "tDCS", "心理治療", "CBT", "ACT", "正念",
  "復健治療", "運動治療", "藥物治療", "睡眠醫學", "疲勞",
  "憂鬱症", "焦慮症", "創傷後壓力症候群", "生活品質",
  "生物標記", "免疫學", "神經科學", "社會心理", "性別差異",
  "臨床試驗", "系統性回顧", "統合分析", "診斷", "流行病學",
  "疼痛管理", "職能治療", "物理治療", "身心醫學",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: "", output: "" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input") opts.input = args[++i];
    else if (args[i] === "--output") opts.output = args[++i];
  }
  return opts;
}

function loadPapers(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function robustJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
    cleaned = lines.join("\n");
  }
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    console.error(`[WARN] First JSON parse failed: ${e1.message}`);
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e2) {
      console.error(`[WARN] Extracted JSON parse failed: ${e2.message}`);
    }
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  cleaned = cleaned.replace(/\\(?!["\\\/bfnrtu])/g, "\\\\");
  cleaned = cleaned.replace(/\t/g, " ");
  cleaned = cleaned.replace(/[\x00-\x1f]/g, (c) => {
    const code = c.charCodeAt(0);
    return code === 10 ? "\\n" : code === 13 ? "\\r" : "";
  });
  try {
    return JSON.parse(cleaned);
  } catch (e3) {
    console.error(`[WARN] Repaired JSON parse failed: ${e3.message}`);
  }
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      let sub = cleaned.slice(start, end + 1);
      let depth = 0;
      let lastValid = sub.length;
      for (let i = 0; i < sub.length; i++) {
        if (sub[i] === "{") depth++;
        else if (sub[i] === "}") depth--;
        if (depth === 0) { lastValid = i + 1; break; }
      }
      sub = sub.slice(0, lastValid);
      return JSON.parse(sub);
    }
  } catch (e4) {
    console.error(`[WARN] All JSON repair attempts failed: ${e4.message}`);
  }
  return null;
}

async function callZhipuAPI(apiKey, papersData) {
  const dateStr = papersData.date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const userPrompt = `以下是 ${dateStr} 從 PubMed 抓取的最新纖維肌痛症與慢性疼痛文獻（共 ${paperCount} 篇）。
請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：
{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "纖維肌痛症": 3,
    "慢性疼痛": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TAG_OPTIONS.join("、")}。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const payload = {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: MAX_TOKENS,
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (resp.status === 429) {
          const wait = 60 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          console.error(`[ERROR] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
          if (resp.status === 429) continue;
          break;
        }

        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        if (!content) {
          console.error(`[WARN] Empty response from ${model}`);
          continue;
        }

        const result = robustJsonParse(content);
        if (!result) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          continue;
        }

        console.error(
          `[INFO] Analysis complete: ${(result.top_picks || []).length} top picks, ${(result.all_papers || []).length} total`
        );
        return result;
      } catch (e) {
        if (e.name === "AbortError") {
          console.error(`[WARN] ${model} timed out after ${TIMEOUT_MS / 1000}s`);
        } else {
          console.error(`[ERROR] ${model} failed: ${e.message}`);
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const dateParts = dateStr.split("-");
  const dateDisplay = dateParts.length === 3
    ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
    : dateStr;

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const d = new Date(dateStr);
  const weekday = weekdays[d.getDay()];

  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = "";
  for (const pick of topPicks) {
    const tags = (pick.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const util = pick.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    const picoHtml = pico.population ? `
      <div class="pico">
        <div class="pico-item"><span class="pico-label">P</span>${esc(pico.population || "-")}</div>
        <div class="pico-item"><span class="pico-label">I</span>${esc(pico.intervention || "-")}</div>
        <div class="pico-item"><span class="pico-label">C</span>${esc(pico.comparison || "-")}</div>
        <div class="pico-item"><span class="pico-label">O</span>${esc(pico.outcome || "-")}</div>
      </div>` : "";
    topPicksHtml += `
      <div class="paper-card top-pick">
        <div class="paper-rank">#${pick.rank || ""}</div>
        <div class="paper-emoji">${pick.emoji || "📄"}</div>
        <span class="utility-badge ${utilityClass}">${esc(util)}實用性</span>
        <h3 class="paper-title">${esc(pick.title_zh || pick.title_en || "")}</h3>
        <div class="paper-journal">${esc(pick.journal || "")} · ${esc(pick.title_en || "")}</div>
        <p class="paper-summary">${esc(pick.summary || "")}</p>
        ${picoHtml}
        <div class="paper-tags">${tags}</div>
        ${pick.url ? `<a class="paper-link" href="${esc(pick.url)}" target="_blank">閱讀原文 →</a>` : ""}
      </div>`;
  }

  let allPapersHtml = "";
  for (const paper of allPapers) {
    const tags = (paper.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const util = paper.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allPapersHtml += `
      <div class="paper-card">
        <div class="paper-emoji">${paper.emoji || "📄"}</div>
        <span class="utility-badge ${utilityClass}">${esc(util)}</span>
        <h3 class="paper-title">${esc(paper.title_zh || paper.title_en || "")}</h3>
        <div class="paper-journal">${esc(paper.journal || "")}</div>
        <p class="paper-summary">${esc(paper.summary || "")}</p>
        <div class="paper-tags">${tags}</div>
        ${paper.url ? `<a class="paper-link" href="${esc(paper.url)}" target="_blank">PubMed →</a>` : ""}
      </div>`;
  }

  let topicBarsHtml = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHtml += `
        <div class="topic-bar-row">
          <span class="topic-label">${esc(topic)}</span>
          <div class="topic-bar-track"><div class="topic-bar-fill" style="width:${widthPct}%"></div></div>
          <span class="topic-count">${count}</span>
        </div>`;
    }
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join("");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chronic Pain · 纖維肌痛症與慢性疼痛文獻日報 · ${dateDisplay}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC',sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.7;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:20px}
.header{text-align:center;padding:48px 20px 32px;background:linear-gradient(135deg,#1e3a5f 0%,#2d1b69 50%,#1a1a2e 100%);border-radius:20px;margin-bottom:32px;position:relative;overflow:hidden}
.header::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle,rgba(99,102,241,0.1) 0%,transparent 60%);animation:pulse 4s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
.header-icon{font-size:64px;margin-bottom:12px;display:block}
.header h1{font-size:28px;color:#f1f5f9;margin-bottom:6px;letter-spacing:1px}
.header .subtitle{color:#94a3b8;font-size:15px}
.header .meta{display:flex;justify-content:center;gap:24px;margin-top:16px;color:#cbd5e1;font-size:14px}
.header .meta span{display:flex;align-items:center;gap:6px}
.section-title{font-size:20px;color:#f1f5f9;margin:32px 0 16px;padding-bottom:8px;border-bottom:2px solid #334155;display:flex;align-items:center;gap:8px}
.section-title .icon{font-size:22px}
.summary-box{background:linear-gradient(135deg,#1e293b 0%,#1a2332 100%);border:1px solid #334155;border-radius:16px;padding:24px;margin:20px 0;font-size:15px;color:#cbd5e1;line-height:1.8}
.paper-card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;margin:16px 0;transition:transform 0.2s,box-shadow 0.2s}
.paper-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.paper-card.top-pick{border-left:4px solid #8b5cf6;background:linear-gradient(135deg,#1e293b 0%,#1a1f35 100%)}
.paper-rank{font-size:24px;font-weight:700;color:#8b5cf6;float:left;margin-right:12px;line-height:1}
.paper-emoji{font-size:28px;display:inline-block;margin-right:8px}
.paper-title{font-size:17px;color:#f1f5f9;margin:8px 0;line-height:1.5}
.paper-journal{font-size:13px;color:#64748b;margin-bottom:8px}
.paper-summary{font-size:14px;color:#cbd5e1;margin:12px 0;line-height:1.8}
.paper-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{background:#2d1b69;color:#c4b5fd;font-size:12px;padding:3px 10px;border-radius:12px;display:inline-block}
.utility-badge{font-size:12px;padding:3px 10px;border-radius:12px;display:inline-block;font-weight:600;margin-left:8px}
.utility-high{background:#065f46;color:#6ee7b7}
.utility-mid{background:#713f12;color:#fcd34d}
.utility-low{background:#7f1d1d;color:#fca5a5}
.pico{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0;padding:12px;background:#0f172a;border-radius:10px}
.pico-item{font-size:13px;color:#94a3b8;display:flex;gap:6px}
.pico-label{background:#8b5cf6;color:#fff;font-weight:700;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px}
.paper-link{display:inline-block;color:#818cf8;text-decoration:none;font-size:14px;margin-top:8px;transition:color 0.2s}
.paper-link:hover{color:#a78bfa}
.topic-section{margin:24px 0}
.topic-bar-row{display:flex;align-items:center;gap:12px;margin:8px 0}
.topic-label{color:#94a3b8;font-size:14px;min-width:100px;text-align:right}
.topic-bar-track{flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden}
.topic-bar-fill{height:100%;background:linear-gradient(90deg,#8b5cf6,#6366f1);border-radius:4px;transition:width 0.5s}
.topic-count{color:#818cf8;font-size:14px;font-weight:600;min-width:24px}
.keywords-section{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.keyword{background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:13px;padding:5px 14px;border-radius:20px}
.footer{text-align:center;padding:32px 20px;margin-top:40px;border-top:1px solid #1e293b}
.footer a{color:#818cf8;text-decoration:none;margin:0 8px;font-size:14px}
.footer a:hover{color:#a78bfa;text-decoration:underline}
.footer .footer-note{color:#475569;font-size:12px;margin-top:12px}
.footer .clinic-links{margin:20px 0;display:flex;flex-wrap:wrap;justify-content:center;gap:16px}
.footer .clinic-links a{background:#1e293b;border:1px solid #334155;padding:10px 20px;border-radius:12px;font-size:14px;display:inline-flex;align-items:center;gap:6px;transition:all 0.2s}
.footer .clinic-links a:hover{background:#2d1b69;border-color:#8b5cf6;color:#c4b5fd;text-decoration:none}
@media(max-width:640px){
  .container{padding:12px}
  .header h1{font-size:22px}
  .pico{grid-template-columns:1fr}
  .topic-label{min-width:80px;font-size:13px}
  .header .meta{flex-direction:column;gap:8px}
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <span class="header-icon">🩺</span>
    <h1>Chronic Pain · 纖維肌痛症與慢性疼痛文獻日報</h1>
    <div class="subtitle">每日自動更新</div>
    <div class="meta">
      <span>📅 ${dateDisplay}（週${weekday}）</span>
      <span>📊 ${totalCount} 篇文獻</span>
      <span>Powered by PubMed + Zhipu AI</span>
    </div>
  </div>

  <div class="section-title"><span class="icon">📋</span> 今日文獻趨勢</div>
  <div class="summary-box">${esc(summary)}</div>

  ${topPicksHtml ? `<div class="section-title"><span class="icon">⭐</span> 今日精選 TOP Picks</div>${topPicksHtml}` : ""}
  ${allPapersHtml ? `<div class="section-title"><span class="icon">📚</span> 其他值得關注的文獻</div>${allPapersHtml}` : ""}

  ${topicBarsHtml ? `<div class="section-title"><span class="icon">📊</span> 主題分佈</div><div class="topic-section">${topicBarsHtml}</div>` : ""}
  ${keywordsHtml ? `<div class="section-title"><span class="icon">🏷️</span> 關鍵字</div><div class="keywords-section">${keywordsHtml}</div>` : ""}

  <div class="footer">
    <div class="clinic-links">
      <a href="https://www.leepsyclinic.com/" target="_blank">🏥 李政洋身心診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" target="_blank">📩 訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" target="_blank">☕ Buy me a coffee</a>
    </div>
    <div class="footer-note">
      資料來源：PubMed · 分析模型：${MODELS[0]}<br>
      <a href="https://github.com/u8901006/chronic-pain-fibromyalgia" target="_blank">GitHub</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.ZHIPU_API_KEY || "";
  if (!apiKey) {
    console.error("[ERROR] No API key. Set ZHIPU_API_KEY env var.");
    process.exit(1);
  }
  if (!opts.input || !opts.output) {
    console.error("[ERROR] --input and --output required");
    process.exit(1);
  }

  const papersData = loadPapers(opts.input);
  if (!papersData?.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    const analysis = {
      date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }),
      market_summary: "今日 PubMed 暫無新的纖維肌痛症與慢性疼痛文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
    const html = generateHtml(analysis);
    mkdirSync(dirname(resolve(opts.output)), { recursive: true });
    writeFileSync(opts.output, html, "utf-8");
    console.error(`[INFO] Empty report saved to ${opts.output}`);
    return;
  }

  const analysis = await callZhipuAPI(apiKey, papersData);
  if (!analysis) {
    console.error("[ERROR] Analysis failed, cannot generate report");
    process.exit(1);
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, html, "utf-8");
  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
