const DAY_MS = 86400000;
const OFFSET_MS = 8 * 3600000;
const WINDOW_MS = 60000;
const PER_MINUTE = 2;
const PER_DAY = 20;

export function quotaDecision(previous, now) {
  const day = Math.floor((now + OFFSET_MS) / DAY_MS);
  const dayEnd = (day + 1) * DAY_MS - OFFSET_MS;
  const recent = (previous?.recent || []).filter(time => time > now - WINDOW_MS);
  const state = previous?.day === day
    ? { ...previous, recent }
    : { day, count: 0, recent };
  if (state.count >= PER_DAY) return {
    allowed: false, code: 'DAILY_LIMIT', retryAfter: Math.max(1, Math.ceil((dayEnd - now) / 1000)),
    error: '今天的 AI 制卡次数已用完，每个网络 IP 每天最多 20 次，北京时间明天零点恢复。'
  };
  if (state.recent.length >= PER_MINUTE) return {
    allowed: false, code: 'MINUTE_LIMIT', retryAfter: Math.max(1, Math.ceil((state.recent[0] + WINDOW_MS - now) / 1000)),
    error: '生成太频繁，每个网络 IP 每分钟最多 2 次，请稍后再试。'
  };
  state.count++;
  state.recent.push(now);
  return { allowed: true, state, dayEnd, remainingToday: PER_DAY - state.count };
}

// One object per pseudonymous IP; storage survives restarts and code deployments.
export class GenerationQuota {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (request.method !== 'POST') return new Response(null, {status:405});
    return this.ctx.blockConcurrencyWhile(async () => {
      const result = await this.ctx.storage.transaction(async tx => {
        const decision = quotaDecision(await tx.get('quota'), Date.now());
        if (decision.allowed) {
          await tx.put('quota', decision.state);
          await tx.setAlarm(decision.dayEnd + WINDOW_MS);
        }
        return decision;
      });
      if (!result.allowed) return Response.json(result, {status:429});
      return Response.json({allowed:true,remainingToday:result.remainingToday});
    });
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get('quota');
      const now = Date.now();
      const today = Math.floor((now + OFFSET_MS) / DAY_MS);
      if (!state || state.day < today) await this.ctx.storage.deleteAll();
      else await this.ctx.storage.setAlarm((today + 1) * DAY_MS - OFFSET_MS + WINDOW_MS);
    });
  }
}

export async function checkQuota(request, env) {
  const unavailable = () => Response.json({ok:false,error:'使用次数检查暂时不可用，请稍后再试。'}, {status:503});
  if (!env.GENERATION_QUOTA) return unavailable();
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return unavailable();
  try {
    // Domain-separated HMAC uses the existing Worker secret; raw IP is not persisted.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.TURNSTILE_SECRET_KEY), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode('flashnote-quota-v1:' + ip));
    const name = Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
    const id = env.GENERATION_QUOTA.idFromName(name);
    const response = await env.GENERATION_QUOTA.get(id).fetch('https://quota.internal/consume', {method:'POST'});
    const data = await response.json();
    if (response.status === 429 && data.allowed === false && ['DAILY_LIMIT','MINUTE_LIMIT'].includes(data.code) && Number.isInteger(data.retryAfter) && data.retryAfter > 0 && data.retryAfter <= 86400) {
      return Response.json({ok:false,error:data.error,code:data.code,retryAfter:data.retryAfter}, {status:429,headers:{'Retry-After':String(data.retryAfter)}});
    }
    if (!response.ok || data.allowed !== true) return unavailable();
    return null;
  } catch { return unavailable(); }
}