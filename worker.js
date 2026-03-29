var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/fh') {
        return await handleFinnhub(url.searchParams, env.FINNHUB_KEY);
      }
      if (path === '/ai' && request.method === 'POST') {
        var body = await request.json();
        return await handleGroq(body, env.GROQ_KEY);
      }
      if (path === '/vision' && request.method === 'POST') {
        var body = await request.json();
        return await handleVision(body, env.GROQ_KEY);
      }
      return makeJson({ status: 'ok', finnhub: !!env.FINNHUB_KEY, groq: !!env.GROQ_KEY }, 200);
    } catch (e) {
      return makeJson({ error: e.message }, 500);
    }
  }
};

async function handleFinnhub(params, key) {
  if (!key) return makeJson({ error: 'FINNHUB_KEY not set' }, 500);

  var type = params.get('type');
  var symbol = params.get('symbol') || '';
  var cat = params.get('category') || 'general';
  var res = params.get('resolution') || 'D';
  var from = params.get('from') || '';
  var to = params.get('to') || '';
  var t = '&token=' + key;
  var b = 'https://finnhub.io/api/v1';
  var u;

  if (type === 'quote') {
    u = b + '/quote?symbol=' + symbol + t;
  } else if (type === 'profile') {
    u = b + '/stock/profile2?symbol=' + symbol + t;
  } else if (type === 'candle') {
    u = b + '/stock/candle?symbol=' + symbol + '&resolution=' + res + '&from=' + from + '&to=' + to + t;
  } else if (type === 'news') {
    u = b + '/news?category=' + cat + t;
  } else if (type === 'company-news') {
    u = b + '/company-news?symbol=' + symbol + '&from=' + from + '&to=' + to + t;
  } else {
    return makeJson({ error: 'Unknown type' }, 400);
  }

  var r = await fetch(u, { headers: { 'User-Agent': 'VERTEX' } });
  var data = await r.json();
  return makeJson(data, 200);
}

async function handleGroq(body, key) {
  if (!key) return makeJson({ error: 'GROQ_KEY not set' }, 500);

  var messages = body.messages;
  var maxTokens = body.maxTokens || 1000;
  if (!messages) return makeJson({ error: 'messages required' }, 400);

  var sys = { role: 'system', content: 'You are a top investment analyst. Respond only in pure JSON.' };
  var all = [sys].concat(messages);

  var payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    max_tokens: maxTokens,
    temperature: 0.7,
    messages: all
  });

  var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: payload
  });

  var data = await r.json();
  if (data.error) return makeJson({ ok: false, error: data.error.message }, 500);

  var text = data.choices[0].message.content || '';
  var cleaned = text.trim();
  if (cleaned.charAt(0) !== '{' && cleaned.charAt(0) !== '[') {
    var start = cleaned.indexOf('{');
    if (start === -1) start = cleaned.indexOf('[');
    if (start !== -1) cleaned = cleaned.slice(start);
    var end = cleaned.lastIndexOf('}');
    var end2 = cleaned.lastIndexOf(']');
    var endIdx = end > end2 ? end : end2;
    if (endIdx !== -1) cleaned = cleaned.slice(0, endIdx + 1);
  }

  try {
    return makeJson({ ok: true, data: JSON.parse(cleaned) }, 200);
  } catch (e) {
    return makeJson({ ok: true, data: { raw: text } }, 200);
  }
}

async function handleVision(body, key) {
  if (!key) return makeJson({ error: 'GROQ_KEY not set' }, 500);

  var imageBase64 = body.image;
  var prompt = body.prompt || 'Extract all stock holdings from this screenshot. Return JSON array with ticker, shares, avgCost fields.';

  if (!imageBase64) return makeJson({ error: 'image required' }, 400);

  var payload = JSON.stringify({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 1500,
    temperature: 0.1,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,' + imageBase64 }
          },
          {
            type: 'text',
            text: prompt
          }
        ]
      }
    ]
  });

  var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: payload
  });

  var data = await r.json();
  if (data.error) return makeJson({ ok: false, error: data.error.message }, 500);

  var text = data.choices[0].message.content || '';
  var cleaned = text.trim();
  var start = cleaned.indexOf('[');
  if (start !== -1) {
    var end = cleaned.lastIndexOf(']');
    if (end !== -1) cleaned = cleaned.slice(start, end + 1);
  }

  try {
    return makeJson({ ok: true, data: JSON.parse(cleaned) }, 200);
  } catch (e) {
    return makeJson({ ok: true, data: { raw: text } }, 200);
  }
}

function makeJson(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    }
  });
}