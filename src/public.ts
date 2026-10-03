import { parseRange } from "./range";
import type { Env, ShareWithFile, DirectLinkWithFile } from "./types";
import { getSettings } from "./settings";
import { reserveDownload } from "./download-accounting";
import { parseUA } from "./ua";
import { clientIp, isAdminWhitelisted } from "./auth";
import { findCodeByString, checkCodeUsable, formatCodeStatus } from "./codes";
import { errorPage, json } from "./pages";
import { hmacHex, sha256Hex, randomHex, safeEqual, decryptSecret } from "./crypto";
import { verifyOAuthSession } from "./oauth";
import { createStorageProvider, type StorageProvider, type StorageObject } from "./storage";

/** 根据当前设置构造存储，避免切换后继续使用旧后端。 */
async function storage(env: Env): Promise<StorageProvider> {
  return createStorageProvider(env, await getSettings(env));
}

const TOKEN_TTL_MS = 24 * 3600_000; // 授权令牌有效期 24h

/* ═══════════ Turnstile 辅助函数 ═══════════ */

/**
 * 计算一个 IP 今天已访问过多少次分享页 → 判断是否需要弹 Turnstile。
 * 同时把计数 +1 写回（用 UPSERT 单次 SQL 原子完成）。
 */
async function trackAndGetVisits(env: Env, ip: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  // 先查 +1
  const upsert = env.db.prepare(
    `INSERT INTO turnstile_visits(ip, day, count) VALUES(?1, ?2, 1)
     ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`
  );
  await upsert.bind(ip, day).run();
  const row = await env.db
    .prepare("SELECT count FROM turnstile_visits WHERE ip = ?1 AND day = ?2")
    .bind(ip, day)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** 从 env 或 settings.cipher 拿到最终的 Turnstile Secret（优先 env） */
async function getTurnstileSecret(env: Env, settings: { turnstileSecretCipher: string | null }): Promise<string | null> {
  if (env.turnstile_secret) return env.turnstile_secret;
  if (settings.turnstileSecretCipher) return await decryptSecret(settings.turnstileSecretCipher, env.admin);
  return null;
}

/** 判断当前 Turnstile 是否可用（secret 必须在 env 或 settings 里配） */
export async function isTurnstileEnabled(
  env: Env,
  settings: { turnstileMode: string; turnstileThreshold: number; turnstileSecretCipher: string | null }
): Promise<boolean> {
  const secret = await getTurnstileSecret(env, settings);
  if (!secret) return false;
  if (settings.turnstileMode === "off") return false;
  return true;
}

/**
 * 返回 Turnstile 状态 + sitekey（前端渲染 widget 用）。
 * 如果 sitekey 没配 → 前端根本不会调 Turnstile 脚本。
 */
export function getTurnstileInfo(
  env: Env,
  settings: { turnstileMode: string; turnstileSitekeyOverride: string | null }
): { sitekey: string | null; mode: string } {
  const sitekey = env.turnstile_sitekey || settings.turnstileSitekeyOverride || null;
  return { sitekey, mode: settings.turnstileMode };
}

/**
 * 验证 Turnstile token —— 向 Cloudflare siteverify 发 POST。
 * 官方要求 POST application/x-www-form-urlencoded: secret + token
 */
export async function verifyTurnstileToken(
  env: Env,
  settings: { turnstileSecretCipher: string | null },
  token: string,
  remoteip: string
): Promise<boolean> {
  const secret = await getTurnstileSecret(env, settings);
  if (!secret || !token) return false;
  try {
    const form = new URLSearchParams({
      secret,
      response: token,
      remoteip,
    });
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean; errorcodes?: string[] };
    return !!j.success;
  } catch {
    return false;
  }
}

/* ═══════════ 分享密码 & 下载授权令牌 ═══════════
 * 密码存储为加盐 SHA-256（salt:sha256(salt:password)）；下载授权用 HMAC 签名携带过期时间，
 * 避免把明文密码拼进下载 URL。HMAC 密钥复用 admin，无需新增 Secret，密钥轮换时短时令牌即失效。
 */
/** 加盐与密码哈希串（salt:hashhex） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomHex();
  return salt + ":" + await sha256Hex(salt + ":" + password);
}
/** 常数时间校验密码 */
async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const i = stored.indexOf(":");
  if (i < 0) return false;
  const salt = stored.slice(0, i);
  const want = stored.slice(i + 1);
  const got = await sha256Hex(salt + ":" + password);
  return safeEqual(want, got);
}
/** 颁发短时下载授权令牌：格式 `${到期时间戳}.${HMAC}` */
async function issueToken(env: Env, token: string): Promise<string> {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = await hmacHex(env.admin, `${token}:${exp}`);
  return `${exp}.${sig}`;
}
/** 校验下载授权令牌（存在于 URL query string 中） */
async function verifyShareToken(env: Env, token: string, query: string): Promise<boolean> {
  const t = new URLSearchParams(query).get("t");
  if (!t) return false;
  const i = t.indexOf(".");
  if (i < 0) return false;
  const exp = Number(t.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = await hmacHex(env.admin, `${token}:${exp}`);
  return safeEqual(t.slice(i + 1), want);
}

/** Short-lived proof prevents spending a single-use Cloudflare token twice. */
async function issueTurnstileProof(env: Env, token: string, ip: string): Promise<string> {
  const exp = Date.now() + 5 * 60_000;
  return `${exp}.${await hmacHex(env.admin, `turnstile:${token}:${ip}:${exp}`)}`;
}
async function verifyTurnstileProof(env: Env, token: string, ip: string, proof: string | null): Promise<boolean> {
  if (!proof) return false;
  const parts = proof.split(".");
  if (parts.length !== 2) return false;
  const [value, sig] = parts;
  const exp = Number(value);
  if (!sig || !Number.isFinite(exp) || exp <= Date.now() || exp > Date.now() + 5 * 60_000) return false;
  return safeEqual(sig, await hmacHex(env.admin, `turnstile:${token}:${ip}:${exp}`));
}
async function needsTurnstile(env: Env, settings: Awaited<ReturnType<typeof getSettings>>, ip: string): Promise<boolean> {
  if (!(await isTurnstileEnabled(env, settings))) return false;
  if (settings.turnstileMode === "both" || settings.turnstileMode === "on_download") return true;
  if (settings.turnstileMode !== "on_share") return false;
  const row = await env.db.prepare("SELECT count FROM turnstile_visits WHERE ip = ?1 AND day = ?2")
    .bind(ip, new Date().toISOString().slice(0, 10)).first<{ count: number }>();
  return (row?.count || 0) > settings.turnstileThreshold;
}

/** GET /s/:token —— 分享页元信息（供前端渲染） */
export async function handleShareInfo(req: Request, env: Env, token: string): Promise<Response> {
  const row = await getShare(env, token);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const settings = await getSettings(env);
  const ip = clientIp(req);
  const isWhitelisted = isAdminWhitelisted(ip, settings.adminIps);
  const quotaExceeded =
    !isWhitelisted && settings.trafficLimitBytes > 0 && settings.trafficUsedBytes >= settings.trafficLimitBytes;
  let status: "ok" | "gone" | "expired" | "maxed" = "ok";
  if (row.revoked) status = "gone";
  else if (row.expires_at && row.expires_at < Date.now()) status = "expired";
  else if (row.max_downloads && row.download_count >= row.max_downloads) status = "maxed";

  // Turnstile：在 share 页面加载时统计一次访问，判断是否需要弹
  const enabled = await isTurnstileEnabled(env, settings);
  let needsTurnstile = false;
  let visitCount = 0;
  let sitekey: string | null = null;
  if (enabled) {
    const { sitekey: sk, mode } = getTurnstileInfo(env, settings);
    sitekey = sk;
    // on_share / both 模式都在此时判断
    if (mode === "on_share" || mode === "both") {
      visitCount = await trackAndGetVisits(env, ip);
      needsTurnstile = visitCount > settings.turnstileThreshold;
    }
  }

  // OAuth2：检查是否已登录
  let oauthAuthed = false;
  let oauthProvider = settings.oauthEnabled ? settings.oauthProvider : "";
  if (settings.oauthEnabled) {
    const oauthCheck = await verifyOAuthSession(env, req.headers.get("cookie"));
    oauthAuthed = oauthCheck.ok;
  }

  // Persist market views before returning so the write survives the request.
  if (status === "ok" && row.is_market) {
    await env.db.prepare("UPDATE shares SET market_views = market_views + 1 WHERE id = ?1 AND is_market = 1")
      .bind(token).run();
  }

  return json({
    status,
    name: row.download_name || row.name,
    size: row.size,
    mime: row.mime,
    downloads: row.download_count,
    created_at: row.created_at,
    expires_at: row.expires_at,
    max_downloads: row.max_downloads,
    needs_password: !!row.password_hash,
    quota_exceeded: quotaExceeded,
    site_title: settings.siteTitle,
    turnstile: {
      enabled,
      sitekey,
      mode: settings.turnstileMode,
      threshold: settings.turnstileThreshold,
      needs_now: needsTurnstile,
      visit_count: visitCount,
    },
    oauth: {
      enabled: settings.oauthEnabled,
      provider: oauthProvider,
      client_id: settings.oauthClientId,
      authed: oauthAuthed,
    },
    codes_floating_button: {
      enabled: settings.codesFloatingButtonEnabled,
      position: settings.codesFloatingButtonPosition,
    },
  });
}

async function getShare(env: Env, token: string): Promise<ShareWithFile | null> {
  return await env.db.prepare(
    `SELECT s.id, s.file_id, s.created_at, s.expires_at, s.max_downloads, s.download_count, s.revoked, s.password_hash,
            s.download_name, s.is_market, f.key, f.name, f.size, f.mime
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE s.id = ?1`
  )
    .bind(token)
    .first<ShareWithFile>();
}

/** 从 direct_links 表查直链记录（独立表、独立 token） */
async function getDirectLink(env: Env, token: string): Promise<DirectLinkWithFile | null> {
  return await env.db.prepare(
    `SELECT dl.id, dl.file_id, dl.created_at, dl.expires_at, dl.max_downloads, dl.download_count, dl.revoked,
            dl.download_name, f.key, f.name, f.size, f.mime
     FROM direct_links dl JOIN files f ON f.id = dl.file_id
     WHERE dl.id = ?1`
  )
    .bind(token)
    .first<DirectLinkWithFile>();
}

/** POST /s/:token/verify —— 校验分享密码 + 可选 Turnstile，成功后颁发下载令牌 */
export async function handleVerify(req: Request, env: Env, token: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
  const row = await getShare(env, token);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  let body: { password?: string; turnstile?: string } = {};
  try {
    body = await req.json();
  } catch {}

  const settings = await getSettings(env);
  const ip = clientIp(req);
  // Check the password first so a typo does not consume the challenge token.
  if (row.password_hash && !(await verifyPassword(row.password_hash, String(body.password ?? ""))))
    return json({ error: "bad_password" }, { status: 401 });
  const params = new URLSearchParams();
  if (await needsTurnstile(env, settings, ip)) {
    if (!(await verifyTurnstileToken(env, settings, String(body.turnstile ?? ""), ip)))
      return json({ error: "turnstile_failed" }, { status: 403 });
    params.set("ts", await issueTurnstileProof(env, token, ip));
  }
  if (row.password_hash) params.set("t", await issueToken(env, token));
  const query = params.toString();
  return json({ ok: true, url: `/s/${token}/download${query ? "?" + query : ""}` });
}

/**
 * GET /s/:token/download —— 分享链接下载主流程
 * 走 shares 表，带完整鉴权链（密码/过期/次数/流量/Turnstile/OAuth/重复下载）
 */
export async function handleDownload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string
): Promise<Response> {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";
  const country = String(req.headers.get("cf-ipcountry") || req.cf?.country || "").toUpperCase();
  const settings = await getSettings(env);

  const urlCode = new URL(req.url).searchParams.get("code");
  const headerCode = req.headers.get("x-activation-code");
  const activationCode = (urlCode || headerCode || "").trim().toUpperCase() || null;

  const [codeRow, ban, row] = await Promise.all([
    activationCode ? findCodeByString(env, activationCode) : Promise.resolve(null),
    env.db.prepare("SELECT reason, expires_at FROM banned_ips WHERE ip = ?1")
      .bind(ip).first<{ reason: string | null; expires_at: number | null }>(),
    getShare(env, token),
  ]);

  if (activationCode && !codeRow) {
    return errorPage(req, 403, { zh: "激活码无效", en: "Invalid Activation Code" },
      { zh: "该激活码不存在或格式不正确。", en: "Activation code not found or invalid." });
  }

  if (activationCode && codeRow) {
    const check = checkCodeUsable(codeRow as any);
    if (!check.ok) {
      const reason = check.reason;
      let title = "激活码不可用";
      if (reason === "exhausted") title = "激活码流量已耗尽";
      if (reason === "expired") title = "激活码已过期";
      if (reason === "revoked") title = "激活码已作废";
      return errorPage(req, 403,
        { zh: title, en: "Activation Code Unavailable" },
        { zh: check.message || reason || "该激活码不可用", en: check.message || "This activation code is not available" },
        { siteTitle: settings.siteTitle });
    }
  }

  if (ban) {
    if (ban.expires_at && ban.expires_at < Date.now()) {
      env.db.prepare("DELETE FROM banned_ips WHERE ip = ?1").bind(ip).run().catch(() => {});
    } else {
      return errorPage(req, 403, { zh: "访问已被封禁", en: "Access Banned" },
        { zh: ban.reason || "由于重复下载行为，该 IP 已被暂时封禁。", en: ban.reason || "This IP has been temporarily banned." });
    }
  }

  if (!row) return errorPage(req, 404, { zh: "链接不存在", en: "Link Not Found" },
    { zh: "该分享链接无效，或已被管理员删除。", en: "This share link is invalid or has been removed." });
  if (row.revoked) return errorPage(req, 410, { zh: "链接已失效", en: "Link Revoked" },
    { zh: "该分享已被管理员撤销。", en: "This share has been revoked." });
  if (row.expires_at && row.expires_at < Date.now()) return errorPage(req, 410, { zh: "链接已过期", en: "Link Expired" },
    { zh: "该分享已超过有效期。", en: "This share has expired." });
  if (row.max_downloads && row.download_count >= row.max_downloads) return errorPage(req, 410, { zh: "下载次数已达上限", en: "Download Limit Reached" },
    { zh: `该资源允许下载 ${row.max_downloads} 次，名额已用完。`, en: `Download limit (${row.max_downloads}) reached.` });



  if (row.password_hash && !(await verifyShareToken(env, token, new URL(req.url).search))) {
    return errorPage(req, 403, { zh: "需要访问密码", en: "Password Required" },
      { zh: "该分享受密码保护。", en: "This share is password-protected." });
  }

  if (settings.oauthEnabled) {
    const oauthResult = await verifyOAuthSession(env, req.headers.get("cookie"));
    if (!oauthResult.ok) {
      const provider = await env.db.prepare("SELECT id, label FROM oauth_providers WHERE enabled = 1 AND client_id != '' AND client_secret_cipher IS NOT NULL AND client_secret_cipher != '' ORDER BY id LIMIT 1")
        .first<{id: string; label: string}>();
      if (!provider) return errorPage(req, 503, {zh: "登录服务未配置", en: "Login unavailable"},
        {zh: "请联系管理员配置可用的登录服务。", en: "Please contact the administrator."});
      const providerName = provider.label || "OAuth";
      const startUrl = `/oauth/start?provider=${encodeURIComponent(provider.id)}&redirect=${encodeURIComponent("/s/" + token)}`;
      return errorPage(req, 401, { zh: "需要登录", en: "OAuth Login Required" },
        { zh: `该资源需要通过 ${providerName} 账号登录后才能下载。`, en: `This resource requires ${providerName} login.` },
        { siteTitle: settings.siteTitle, oauth_login_url: startUrl });
    }
  }

  if (await needsTurnstile(env, settings, ip)) {
    const url = new URL(req.url);
    // Legacy direct clients may still supply a fresh raw token.
    const proof = await verifyTurnstileProof(env, token, ip, url.searchParams.get("ts"));
    const rawToken = url.searchParams.get("cf");
    if (!proof && !(rawToken && await verifyTurnstileToken(env, settings, rawToken, ip))) {
      return errorPage(req, 403, { zh: "验证码校验失败", en: "Turnstile Failed" },
        { zh: "请重新完成人机验证。", en: "Please complete human verification again." },
        { siteTitle: settings.siteTitle });
    }
  }

  {
    const whitelisted = isAdminWhitelisted(ip, settings.adminIps);
    const usingCode = !!codeRow;
    if (!whitelisted && !usingCode && settings.trafficLimitBytes > 0 && settings.trafficUsedBytes >= settings.trafficLimitBytes) {
      return errorPage(req, 503, { zh: "下载已暂停", en: "Downloads Paused" },
        { zh: "本月流量已达预设限额。", en: "Monthly traffic quota reached." },
        { siteTitle: settings.siteTitle });
    }
  }

  {
    const whitelisted = isAdminWhitelisted(ip, settings.adminIps);
    const usingCode = !!codeRow;
    if (!whitelisted && !usingCode && settings.maxDownloadsPerIp > 0) {
      const since = settings.countWindowHours > 0 ? Date.now() - settings.countWindowHours * 3600_000 : 0;
      const { c } = (await env.db.prepare(
        "SELECT COUNT(*) AS c FROM download_logs WHERE share_id = ?1 AND ip = ?2 AND created_at > ?3"
      ).bind(token, ip, since).first<{ c: number }>()) ?? { c: 0 };
      if (c >= settings.maxDownloadsPerIp) {
        if (settings.autoBan) {
          const expiresAt = settings.banHours > 0 ? Date.now() + settings.banHours * 3600_000 : null;
          await env.db.prepare(
            `INSERT INTO banned_ips(ip, reason, banned_at, expires_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at, expires_at = excluded.expires_at`
          ).bind(ip, `重复下载「${row.name}」超过 ${settings.maxDownloadsPerIp} 次`, Date.now(), expiresAt).run();
        }
        return errorPage(req, 403, { zh: "重复下载被拦截", en: "Duplicate Download Blocked" },
          { zh: `同一 IP 在统计窗口内下载此资源的次数已达上限（${settings.maxDownloadsPerIp} 次）。`,
            en: `This IP has reached the download limit (${settings.maxDownloadsPerIp}).` },
          { siteTitle: settings.siteTitle });
      }
    }
  }

  return streamFile(req, env, ctx, row, token, "share");
}

/**
 * GET /d/:id —— 直链下载（独立入口，走 direct_links 表）
 * 轻量鉴权：封禁 → 过期/撤销/次数 → 原子扣次 → 流量限额 → 重复下载
 * 不走密码/Turnstile/OAuth（直链设计就是"拿了就能下"）
 */
export async function handleDirectDownload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string
): Promise<Response> {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";
  const country = String(req.headers.get("cf-ipcountry") || req.cf?.country || "").toUpperCase();
  const settings = await getSettings(env);

  const urlCode = new URL(req.url).searchParams.get("code");
  const headerCode = req.headers.get("x-activation-code");
  const activationCode = (urlCode || headerCode || "").trim().toUpperCase() || null;

  const [codeRow, ban, row] = await Promise.all([
    activationCode ? findCodeByString(env, activationCode) : Promise.resolve(null),
    env.db.prepare("SELECT reason, expires_at FROM banned_ips WHERE ip = ?1")
      .bind(ip).first<{ reason: string | null; expires_at: number | null }>(),
    getDirectLink(env, token),
  ]);

  if (activationCode && !codeRow) {
    return errorPage(req, 403, { zh: "激活码无效", en: "Invalid Activation Code" },
      { zh: "该激活码不存在或格式不正确。", en: "Activation code not found or invalid." });
  }

  if (activationCode && codeRow) {
    const check = checkCodeUsable(codeRow as any);
    if (!check.ok) {
      return errorPage(req, 403,
        { zh: "激活码不可用", en: "Activation Code Unavailable" },
        { zh: check.message || check.reason || "该激活码不可用", en: check.message || "This activation code is not available" },
        { siteTitle: settings.siteTitle });
    }
  }

  if (ban) {
    if (ban.expires_at && ban.expires_at < Date.now()) {
      env.db.prepare("DELETE FROM banned_ips WHERE ip = ?1").bind(ip).run().catch(() => {});
    } else {
      return errorPage(req, 403, { zh: "访问已被封禁", en: "Access Banned" },
        { zh: ban.reason || "该 IP 已被暂时封禁。", en: ban.reason || "This IP has been banned." });
    }
  }

  if (!row) return errorPage(req, 404, { zh: "直链不存在", en: "Not Found" },
    { zh: "该直链无效或已被管理员删除。", en: "Direct link invalid or removed." });
  if (row.revoked) return errorPage(req, 410, { zh: "直链已失效", en: "Link Revoked" },
    { zh: "该直链已被撤销。", en: "Direct link revoked." });
  if (row.expires_at && row.expires_at < Date.now()) return errorPage(req, 410, { zh: "直链已过期", en: "Link Expired" },
    { zh: "该直链已超过有效期。", en: "Direct link expired." });
  if (row.max_downloads && row.download_count >= row.max_downloads) return errorPage(req, 410, { zh: "下载次数已达上限", en: "Download Limit Reached" },
    { zh: `名额已用完。`, en: `Quota used up.` });



  {
    const whitelisted = isAdminWhitelisted(ip, settings.adminIps);
    const usingCode = !!codeRow;
    if (!whitelisted && !usingCode && settings.trafficLimitBytes > 0 && settings.trafficUsedBytes >= settings.trafficLimitBytes) {
      return errorPage(req, 503, { zh: "下载已暂停", en: "Downloads Paused" },
        { zh: "本月流量已达预设限额。", en: "Monthly traffic quota reached." },
        { siteTitle: settings.siteTitle });
    }
  }

  {
    const whitelisted = isAdminWhitelisted(ip, settings.adminIps);
    const usingCode = !!codeRow;
    if (!whitelisted && !usingCode && settings.maxDownloadsPerIp > 0) {
      const since = settings.countWindowHours > 0 ? Date.now() - settings.countWindowHours * 3600_000 : 0;
      const { c } = (await env.db.prepare(
        "SELECT COUNT(*) AS c FROM download_logs WHERE share_id = ?1 AND ip = ?2 AND created_at > ?3"
      ).bind(token, ip, since).first<{ c: number }>()) ?? { c: 0 };
      if (c >= settings.maxDownloadsPerIp) {
        if (settings.autoBan) {
          const expiresAt = settings.banHours > 0 ? Date.now() + settings.banHours * 3600_000 : null;
          await env.db.prepare(
            `INSERT INTO banned_ips(ip, reason, banned_at, expires_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at, expires_at = excluded.expires_at`
          ).bind(ip, `重复下载直链「${row.name}」超过 ${settings.maxDownloadsPerIp} 次`, Date.now(), expiresAt).run();
        }
        return errorPage(req, 403, { zh: "重复下载被拦截", en: "Duplicate Download Blocked" },
          { zh: `同一 IP 在统计窗口内下载此资源的次数已达上限。`, en: `IP download limit reached.` },
          { siteTitle: settings.siteTitle });
      }
    }
  }

  return streamFile(req, env, ctx, row, token, "direct");
}

/* ════════════════════════════════════════════════════════════════════
 * streamFile —— 共享的"从存储后端读取 → 流式输出 → 后台记日志"逻辑
 * handleDownload（分享链接）和 handleDirectDownload（直链）共用此函数
 * ════════════════════════════════════════════════════════════════════ */

interface StreamFileRow {
  file_id: string;
  key: string;
  name: string;
  size: number;
  mime: string;
  download_name?: string | null;
}

async function streamFile(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  row: StreamFileRow,
  token: string,
  kind: "share" | "direct"
): Promise<Response> {
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";
  const country = String(req.headers.get("cf-ipcountry") || req.cf?.country || "").toUpperCase();
  const settings = await getSettings(env);

  const urlCode = new URL(req.url).searchParams.get("code");
  const headerCode = req.headers.get("x-activation-code");
  const activationCode = (urlCode || headerCode || "").trim().toUpperCase() || null;
  const codeRow = activationCode ? await findCodeByString(env, activationCode) : null;
  if(activationCode && (!codeRow || !checkCodeUsable(codeRow).ok))
    return errorPage(req,403,{zh:"激活码不可用",en:"Activation Code Unavailable"},
      {zh:"激活码已失效，请重新绑定。",en:"Please bind a valid activation code."});

  const isHead = req.method === "HEAD";
  const rangeHeader = isHead ? null : req.headers.get("range");
  const range = parseRange(rangeHeader, row.size);
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${row.size}` } });
  }
  let obj: (Partial<StorageObject> & { size: number; contentType: string }) | null;
  try {
    const st = await storage(env);
    obj = isHead ? await st.head(row.key) : await st.get(row.key, range ? { offset: range.offset, length: range.length } : undefined);
  } catch (err: any) {
    console.error("[download] storage error:", err);
    return errorPage(req, 502, { zh: "存储服务错误", en: "Storage Error" },
      { zh: "无法从存储后端读取文件。", en: "Cannot read file from storage." });
  }
  if (!obj)
    return errorPage(req, 404, { zh: "文件不存在", en: "File Not Found" },
      { zh: "文件可能已被删除。", en: "File may have been deleted." });

  if(!range && obj.size !== row.size) await env.db.prepare("UPDATE files SET size=?1 WHERE id=?2 AND size=?3")
    .bind(obj.size,row.file_id,row.size).run();
  const headers = new Headers();
  headers.set("content-type", obj.contentType);
  if (obj.etag) headers.set("etag", obj.etag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  const displayName = row.download_name || row.name;
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  const { addSecurityHeaders } = await import("./pages");
  addSecurityHeaders(headers, { isDownload: true });
  const servedLen = range ? range.length : obj.size;
  headers.set("content-length", String(servedLen));
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + servedLen - 1}/${obj.size}`);
  }

  // HEAD only reads metadata. Reserve the link allowance and activation quota
  // atomically before returning any file body; failed authorization never pays.
  if (isHead) return new Response(null, { headers });
  const body = obj.body;
  if (!body) return errorPage(req, 502,
    { zh: "文件内容不可读取", en: "Invalid Storage Response" },
    { zh: "存储后端未返回文件内容。", en: "Storage returned no file body." });
  const {browser, os} = parseUA(ua);
  const reservation = await reserveDownload(env, kind, token, codeRow, servedLen, {
    whitelisted:isAdminWhitelisted(ip, settings.adminIps),
    log:{fileId:row.file_id,fileName:row.name,ip,ua,browser,os,country}
  });
  if (!reservation.ok) {
    await body.cancel().catch(() => {});
    if(reservation.reason === "ip" && settings.autoBan) await env.db.prepare(`INSERT INTO banned_ips(ip,reason,banned_at,expires_at) VALUES(?1,?2,?3,?4)
      ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason,banned_at=excluded.banned_at,expires_at=excluded.expires_at`)
      .bind(ip,"Download limit exceeded",Date.now(),settings.banHours > 0 ? Date.now()+settings.banHours*3600_000 : null).run();
    return errorPage(req, reservation.reason === "traffic" ? 503 : reservation.reason === "link" ? 410 : 403,
      { zh: "下载不可用", en: "Download Unavailable" },
      { zh: reservation.reason === "quota" ? "激活码剩余额度不足或已失效。" : reservation.reason === "traffic" ? "本月剩余流量不足。" : reservation.reason === "ip" ? "该 IP 下载次数已达上限。" : "链接已失效或下载名额已用完。",
        en: "Link unavailable or insufficient activation quota." });
  }

  // Accounting and logs are committed; only optional analytics run in the background.
  const bytes = servedLen;
  const codeId = codeRow ? codeRow.code : null;
  ctx.waitUntil(
    (async () => {
      const { browser, os } = parseUA(ua);

      if (env.analytics) {
        try {
          const latitude = req.headers.get("cf-ip-latitude") ?? "";
          const longitude = req.headers.get("cf-ip-longitude") ?? "";
          env.analytics.writeDataPoint({
            blobs: [
              country, row.name, browser, os, token,
              codeId ?? "none", latitude, longitude,
              settings.storageProvider || "r2",
            ],
            doubles: [bytes, 1],
            indexes: [token],
          });
        } catch { /* ignore */ }
      }


    })()
  );

  return new Response(body, { status: range ? 206 : 200, headers });
}
