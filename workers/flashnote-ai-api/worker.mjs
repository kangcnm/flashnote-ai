const SITE_ORIGIN = "https://kangcnm.github.io";
const API_URL = "https://api.deepseek.com/chat/completions";

function makeHeaders(origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };

  if (origin === SITE_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = SITE_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return headers;
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: makeHeaders(origin)
  });
}

async function verifyTurnstile(request, env, token) {
  const reject = (status, error) => Response.json({ok:false,error}, {status});
  if (!env.TURNSTILE_SECRET_KEY) return reject(503, '安全验证尚未配置');
  if (typeof token !== 'string' || !token.trim() || token.length > 2048)
    return reject(403, '请重新完成安全验证');
  let result;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token,
        remoteip:request.headers.get('CF-Connecting-IP') || undefined}),
      signal: AbortSignal.timeout(10000)
    });
    result = await response.json();
    if (!result || typeof result !== 'object') return reject(503, '安全验证服务返回异常，请稍后重试');
    const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret'))
      return reject(503, '安全验证密钥配置有误，请检查 Worker 中的 TURNSTILE_SECRET_KEY');
    if (codes.includes('timeout-or-duplicate'))
      return reject(403, '验证已过期或已使用，请重新验证');
    if (codes.includes('invalid-input-response') || codes.includes('missing-input-response'))
      return reject(403, '安全验证失败，请重新验证');
    if (!response.ok || codes.includes('internal-error')) return reject(503, '安全验证服务暂时不可用，请稍后重试');
  } catch {
    return reject(503, '安全验证暂时不可用');
  }
  if (result.success !== true || result.hostname !== 'kangcnm.github.io' || result.action !== 'generate')
    return reject(403, '安全验证失败，请重新验证');
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (origin && origin !== SITE_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      if (origin !== SITE_ORIGIN) {
        return new Response("Forbidden", { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: makeHeaders(origin)
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "flashnote-ai-api",
        message: "闪记 AI 后端已运行"
      }, 200, origin);
    }

    if (url.pathname !== "/api/generate") {
      return jsonResponse({ error: "接口不存在" }, 404, origin);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "请使用 POST 请求" }, 405, origin);
    }

    if (origin !== SITE_ORIGIN) {
      return jsonResponse({ error: "请求来源不允许" }, 403, origin);
    }

    if (!env.DEEPSEEK_API_KEY) {
      return jsonResponse({
        error: "服务器尚未配置 DEEPSEEK_API_KEY"
      }, 500, origin);
    }

    let input;

    try {
      const rawBody = await request.text();

      if (rawBody.length > 20000) {
        return jsonResponse({ error: "笔记过长，请缩短后重试" }, 413, origin);
      }

      input = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "请求内容不是有效的 JSON" }, 400, origin);
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return jsonResponse({ ok: false, error: "请求内容必须是 JSON 对象" }, 400, origin);
    }

    const notes = String(input.notes || "").trim();
    const topic = String(input.topic || "课堂笔记").trim().slice(0, 80);
    const level = ["入门", "进阶", "混合"].includes(input.level)
      ? input.level
      : "入门";

    const requestedAmount = Number.parseInt(input.amount, 10);
    const amount = [5, 8, 12].includes(requestedAmount)
      ? requestedAmount
      : 8;

    if (!notes) {
      return jsonResponse({ error: "请先输入课堂笔记" }, 400, origin);
    }

    if (notes.length > 12000) {
      return jsonResponse({ error: "笔记最多支持 12000 个字符" }, 413, origin);
    }

    const denied = await verifyTurnstile(request, env, input.turnstileToken);
    if (denied) {
      return new Response(denied.body, {status: denied.status, headers: makeHeaders(origin)});
    }

    const systemPrompt = `
你是一名严谨的中文学习辅导助手，负责把课堂笔记制作成复习卡片。

请只输出合法 JSON，不要输出 Markdown 或代码围栏。
格式必须为：
{
  "cards": [
    {
      "question": "一个清晰的问题",
      "answer": "准确、简明的答案",
      "tag": "知识分类"
    }
  ]
}

规则：
1. 尽量生成 ${amount} 张卡片，难度为「${level}」。
2. 优先覆盖核心概念、应用场景、操作步骤和容易混淆的知识点。
3. 以用户提供的笔记为主要依据，不要编造笔记无法支持的具体事实。
4. 每张卡片只问一个问题，答案应简明、适合复习。
5. question、answer、tag 必须都是字符串。
6. 不足以生成有效题目的内容可以少生成，不要为了凑数而胡编。
7. 问题尽量不超过40字，答案不超过80字，标签不超过20字；不要重复出题。
`;

    let upstream;
    let result;
    const providerController = new AbortController();
    const providerTimer = setTimeout(() => providerController.abort(), 45000);

    try {
      upstream = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        signal: providerController.signal,
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `课程：${topic}\n课堂笔记：\n${notes}`
            }
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: 0.2,
          max_tokens: Math.min(3200, 512 + amount * 220),
          stream: false
        })
      });
      if (upstream.ok) result = await upstream.json();
    } catch (error) {
      if (providerController.signal.aborted) return jsonResponse({ok:false,code:'PROVIDER_TIMEOUT',error:'AI 服务响应超过45秒，请稍后重试，或先生成5张卡片。'},504,origin);
      if (error instanceof SyntaxError) return jsonResponse({ok:false,code:'PROVIDER_RESPONSE',error:'AI 服务返回内容异常，请稍后重试。'},502,origin);
      return jsonResponse({ok:false,code:'PROVIDER_NETWORK',error:'制卡服务器暂时无法连接 AI 服务，请稍后再试。'},502,origin);
    } finally { clearTimeout(providerTimer); }

    if (!upstream.ok) {
      return jsonResponse({
        error: "DeepSeek 调用失败，请检查 API 密钥、余额和模型权限",
        providerStatus: upstream.status
      }, 502, origin);
    }

    if (result?.choices?.[0]?.finish_reason === 'length') {
      return jsonResponse({ok:false,code:'OUTPUT_LIMIT',error:'AI 输出过长，请先选择5张卡片重试。'},502,origin);
    }

    const content = result.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      return jsonResponse({ error: "AI 没有返回有效内容，请重试" }, 502, origin);
    }

    let parsed;

    try {
      parsed = JSON.parse(
        content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      );
    } catch {
      return jsonResponse({ error: "AI 返回格式异常，请重新生成" }, 502, origin);
    }

    if (!parsed || !Array.isArray(parsed.cards)) {
      return jsonResponse({ error: "AI 返回的卡片格式不正确" }, 502, origin);
    }

    const cards = parsed.cards
      .slice(0, amount)
      .filter(card => card && typeof card === "object")
      .map(card => ({
        question: String(card.question || "").trim().slice(0, 600),
        answer: String(card.answer || "").trim().slice(0, 4000),
        tag: String(card.tag || topic).trim().slice(0, 80) || topic
      }))
      .filter(card => card.question && card.answer);

    if (cards.length === 0) {
      return jsonResponse({ error: "没有生成有效卡片，请补充更多笔记" }, 502, origin);
    }

    return jsonResponse({
      ok: true,
      cards,
      count: cards.length
    }, 200, origin);
  }
};