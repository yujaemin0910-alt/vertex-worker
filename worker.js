// ── VERTEX Worker v3 ──────────────────────────────────────
// AI: OpenRouter (무료 모델 자동 로테이션)
// 주가: Finnhub (primary) + Polygon.io (fallback)
// 뉴스: Finnhub
// Vision: Groq llama-4-maverick

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// OpenRouter 무료 모델 목록 (rate limit 초과 시 순서대로 다음 모델 시도)
var OR_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "qwen/qwen-2-7b-instruct:free"
];

var SYS_PROMPT = "당신은 월스트리트 최고 투자 애널리스트입니다. 반드시 순수 JSON만 응답하세요. 한자·중국어·일본어·베트남어 등 기타 언어는 단 1글자도 포함하지 마세요. 모든 텍스트는 한국어 또는 영어(티커·고유명사)로만 작성하세요. 기사에 없는 내용은 절대 지어내지 마세요.";

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === "/fh")      return await handleFinnhub(url.searchParams, env.FINNHUB_KEY, env.POLYGON_KEY);
      if (path === "/ai"    && request.method === "POST") return await handleOpenRouter(await request.json(), env.OPENROUTER_KEY);
      if (path === "/vision" && request.method === "POST") return await handleGroqVision(await request.json(), env.GROQ_KEY);
      if (path === "/crawl"  && request.method === "POST") return await handleCrawl(await request.json());

      return makeJson({
        status: "ok",
        finnhub:     !!env.FINNHUB_KEY,
        polygon:     !!env.POLYGON_KEY,
        openrouter:  !!env.OPENROUTER_KEY,
        groq:        !!env.GROQ_KEY
      }, 200);

    } catch (e) {
      return makeJson({ error: e.message }, 500);
    }
  }
};

// ── Finnhub (primary) + Polygon.io (fallback for quotes) ──
async function handleFinnhub(params, fhKey, polyKey) {
  if (!fhKey) return makeJson({ error: "FINNHUB_KEY not set" }, 500);

  var type   = params.get("type");
  var symbol = params.get("symbol") || "";
  var cat    = params.get("category") || "general";
  var res    = params.get("resolution") || "D";
  var from   = params.get("from") || "";
  var to     = params.get("to") || "";
  var q      = params.get("q") || "";
  var t      = "&token=" + fhKey;
  var b      = "https://finnhub.io/api/v1";
  var u;

  if (type === "quote")        u = b + "/quote?symbol=" + symbol + t;
  else if (type === "profile") u = b + "/stock/profile2?symbol=" + symbol + t;
  else if (type === "candle")  u = b + "/stock/candle?symbol=" + symbol + "&resolution=" + res + "&from=" + from + "&to=" + to + t;
  else if (type === "news")    u = b + "/news?category=" + cat + t;
  else if (type === "company-news") u = b + "/company-news?symbol=" + symbol + "&from=" + from + "&to=" + to + t;
  else if (type === "search")  u = b + "/search?q=" + encodeURIComponent(q) + t;
  else return makeJson({ error: "Unknown type" }, 400);

  try {
    var r = await fetch(u, {
      headers: { "User-Agent": "VERTEX/3.0" },
      signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) throw new Error("FH HTTP " + r.status);
    var data = await r.json();

    // quote 실패 또는 c=0 이면 Polygon fallback
    if (type === "quote" && polyKey && (!data.c || data.c === 0)) {
      return await handlePolygonQuote(symbol, polyKey);
    }

    return makeJson(data, 200);
  } catch (e) {
    // Finnhub 실패 시 quote는 Polygon fallback
    if (type === "quote" && polyKey) {
      return await handlePolygonQuote(symbol, polyKey);
    }
    return makeJson({ error: e.message }, 500);
  }
}

// ── Polygon.io quote fallback ──────────────────────────────
async function handlePolygonQuote(symbol, key) {
  try {
    var r = await fetch(
      "https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/" + symbol + "?apiKey=" + key,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error("Polygon HTTP " + r.status);
    var data = await r.json();
    var snap = data?.ticker?.day;
    var prev = data?.ticker?.prevDay;
    var last = data?.ticker?.lastTrade?.p || data?.ticker?.lastQuote?.P || snap?.c || 0;
    var prevClose = prev?.c || 0;
    var change = last - prevClose;
    var changePct = prevClose ? (change / prevClose * 100) : 0;

    // Finnhub quote 형식으로 변환
    return makeJson({
      c:  last,
      d:  change,
      dp: changePct,
      h:  snap?.h || 0,
      l:  snap?.l || 0,
      o:  snap?.o || 0,
      pc: prevClose,
      _src: "polygon"
    }, 200);
  } catch (e) {
    return makeJson({ error: "Polygon fallback failed: " + e.message }, 500);
  }
}

// ── OpenRouter (무료 모델 자동 로테이션) ───────────────────
async function handleOpenRouter(body, key) {
  if (!key) return makeJson({ error: "OPENROUTER_KEY not set" }, 500);

  var messages   = body.messages;
  var maxTokens  = body.maxTokens || 1200;
  if (!messages) return makeJson({ error: "messages required" }, 400);

  var sysMsg = { role: "system", content: SYS_PROMPT };
  var lastError = "";

  for (var i = 0; i < OR_MODELS.length; i++) {
    var model = OR_MODELS[i];
    try {
      var r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + key,
          "HTTP-Referer":  "https://jamnastockinsight.pages.dev",
          "X-Title":       "VERTEX Stock Intelligence"
        },
        body: JSON.stringify({
          model:      model,
          max_tokens: maxTokens,
          temperature: 0.5,
          messages:   [sysMsg].concat(messages)
        }),
        signal: AbortSignal.timeout(30000)
      });

      var data = await r.json();

      // Rate limit → 다음 모델 시도
      if (r.status === 429 || data?.error?.code === 429) {
        lastError = model + " rate limited";
        continue;
      }

      if (data.error) {
        lastError = data.error.message || data.error;
        continue;
      }

      var text = data.choices?.[0]?.message?.content || "";
      var cleaned = text.trim();

      // JSON 추출
      var start = cleaned.indexOf("{");
      if (start > 0) cleaned = cleaned.slice(start);
      var end = cleaned.lastIndexOf("}");
      if (end !== -1) cleaned = cleaned.slice(0, end + 1);

      try {
        return makeJson({ ok: true, data: JSON.parse(cleaned), _model: model }, 200);
      } catch (e) {
        return makeJson({ ok: true, data: { raw: text }, _model: model }, 200);
      }

    } catch (e) {
      lastError = e.message;
      continue;
    }
  }

  return makeJson({ ok: false, error: "모든 AI 모델 한도 초과. 잠시 후 다시 시도해주세요. (" + lastError + ")" }, 429);
}

// ── Groq Vision (스크린샷 분석) ───────────────────────────
async function handleGroqVision(body, key) {
  if (!key) return makeJson({ error: "GROQ_KEY not set" }, 500);
  var image  = body.image;
  var prompt = body.prompt || "";
  if (!image) return makeJson({ error: "image required" }, 400);

  var r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + key
    },
    body: JSON.stringify({
      model:      "meta-llama/llama-4-maverick-17b-128e-instruct",
      max_tokens: 1500,
      temperature: 0.1,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image } },
          { type: "text", text: prompt }
        ]
      }]
    }),
    signal: AbortSignal.timeout(40000)
  });

  var data = await r.json();
  if (data.error) return makeJson({ ok: false, error: data.error.message }, 500);

  var text    = data.choices?.[0]?.message?.content || "";
  var cleaned = text.trim();
  var start   = cleaned.indexOf("[");
  if (start !== -1) {
    var end = cleaned.lastIndexOf("]");
    if (end !== -1) {
      try {
        return makeJson({ ok: true, data: JSON.parse(cleaned.slice(start, end + 1)) }, 200);
      } catch (e) {}
    }
  }
  return makeJson({ ok: true, data: { raw: text } }, 200);
}

// ── Web Crawl ─────────────────────────────────────────────
async function handleCrawl(body) {
  var url = body.url;
  if (!url) return makeJson({ ok: false, error: "url required" }, 400);
  try {
    var r = await fetch(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control":   "no-cache"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) return makeJson({ ok: false, error: "HTTP " + r.status }, 200);
    var raw = await r.text();
    raw = raw.replace(/<script[\s\S]*?<\/script>/gi, "");
    raw = raw.replace(/<style[\s\S]*?<\/style>/gi, "");
    raw = raw.replace(/<nav[\s\S]*?<\/nav>/gi, "");
    raw = raw.replace(/<header[\s\S]*?<\/header>/gi, "");
    raw = raw.replace(/<footer[\s\S]*?<\/footer>/gi, "");
    raw = raw.replace(/<aside[\s\S]*?<\/aside>/gi, "");
    raw = raw.replace(/<[^>]+>/g, " ");
    raw = raw.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    raw = raw.replace(/\s{2,}/g, " ").trim();
    if (raw.length < 150) return makeJson({ ok: false, error: "paywall or blocked" }, 200);
    return makeJson({ ok: true, text: raw.slice(0, 3500), length: raw.length }, 200);
  } catch (e) {
    return makeJson({ ok: false, error: e.message }, 200);
  }
}

// ── Response helper ────────────────────────────────────────
function makeJson(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type":                 "application/json"
    }
  });
}
