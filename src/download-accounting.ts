import type { Env } from "./types";
import type { ActivationCodeRow } from "./codes";
import { prepareQuotaDeduction } from "./codes";
import { getSettings, invalidateSettingsCache } from "./settings";

interface DownloadLog {
  fileId: string; fileName: string; ip: string; ua: string;
  browser: string; os: string; country: string;
}

/** Reserve quota, allowance, traffic and the IP log in one D1 transaction. */
export async function reserveDownload(
  env: Env, kind: "share" | "direct", token: string,
  code: ActivationCodeRow | null, bytes: number,
  options: {whitelisted?: boolean; log?: DownloadLog} = {}
): Promise<{ok: boolean; reason?: "quota" | "link" | "traffic" | "ip"}> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid download size");
  const table = kind === "share" ? "shares" : "direct_links";
  const now = Date.now(), month = new Date(now).toISOString().slice(0,7), day = new Date(now).toISOString().slice(0,10);
  const settings = await getSettings(env);
  const available = `revoked = 0 AND (expires_at IS NULL OR expires_at > ${now})
    AND (max_downloads IS NULL OR max_downloads = 0 OR download_count < max_downloads)`;
  const statements: D1PreparedStatement[] = [];
  const bypass = !!code || !!options.whitelisted;
  let linkIndex = 0;
  if (code) {
    statements.push(prepareQuotaDeduction(env, code.id, bytes, now,
      `AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?4 AND ${available})`, [token]));
    linkIndex = 1;
    statements.push(env.db.prepare(`UPDATE ${table} SET download_count = download_count + 1
      WHERE id = ?1 AND changes() = 1 AND ${available}`).bind(token));
  } else {
    const since = settings.countWindowHours > 0 ? now - settings.countWindowHours * 3600_000 : 0;
    const limit = `COALESCE(CAST((SELECT value FROM settings WHERE key='traffic_limit_bytes') AS INTEGER), ?3)`;
    const used = `CASE WHEN (SELECT value FROM settings WHERE key='traffic_month') = ?4
      THEN COALESCE(CAST((SELECT value FROM settings WHERE key='traffic_used_bytes') AS INTEGER),0) ELSE 0 END`;
    const trafficGate = bypass ? "" : `AND (${limit} = 0 OR (${used}) + ?2 <= ${limit})`;
    const ipGate = !bypass && options.log && settings.maxDownloadsPerIp > 0
      ? `AND (SELECT COUNT(*) FROM download_logs WHERE share_id = ?1 AND ip = ?5 AND created_at >= ?6) < ?7` : "";
    const values: (string | number)[] = [token];
    if (!bypass) values.push(bytes,settings.trafficLimitBytes,month);
    if (ipGate) values.push(options.log!.ip,since,settings.maxDownloadsPerIp);
    statements.push(env.db.prepare(`UPDATE ${table} SET download_count = download_count + 1
      WHERE id = ?1 AND ${available} ${trafficGate} ${ipGate}`).bind(...values));
  }
  // Each following write requires the preceding statement to have changed a row.
  statements.push(env.db.prepare(`INSERT INTO settings(key,value)
    SELECT 'traffic_used_bytes', CAST(?2 AS TEXT) WHERE changes() = 1
    ON CONFLICT(key) DO UPDATE SET value = CAST(
      (CASE WHEN (SELECT value FROM settings WHERE key='traffic_month') = ?1
       THEN CAST(settings.value AS INTEGER) ELSE 0 END) + ?2 AS TEXT)`).bind(month,bytes));
  statements.push(env.db.prepare(`INSERT INTO settings(key,value) SELECT 'traffic_month', ?1 WHERE changes() = 1
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(month));
  statements.push(env.db.prepare(`INSERT INTO traffic_stats(day,bytes,downloads) SELECT ?1,?2,1 WHERE changes() = 1
    ON CONFLICT(day) DO UPDATE SET bytes=bytes+excluded.bytes, downloads=downloads+1`).bind(day,bytes));
  if(options.log) {
    const log = options.log;
    statements.push(env.db.prepare(`INSERT INTO download_logs(share_id,file_id,file_name,ip,ua,browser,os,country,bytes,created_at,activation_code)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE changes() = 1`)
      .bind(token,log.fileId,log.fileName,log.ip,log.ua.slice(0,500),log.browser,log.os,log.country,bytes,now,code?.code || null));
  }
  const results = await env.db.batch(statements);
  invalidateSettingsCache();
  if(results[linkIndex].meta.changes === 1) return {ok:true};
  const link = await env.db.prepare(`SELECT id FROM ${table} WHERE id=?1 AND ${available}`).bind(token).first();
  if (!link) return {ok:false,reason:"link"};
  if (code) return {ok:false,reason:"quota"};
  if (!bypass && options.log && settings.maxDownloadsPerIp > 0) {
    const since = settings.countWindowHours > 0 ? now - settings.countWindowHours * 3600_000 : 0;
    const count = await env.db.prepare("SELECT COUNT(*) AS n FROM download_logs WHERE share_id=?1 AND ip=?2 AND created_at>=?3")
      .bind(token,options.log.ip,since).first<{n:number}>();
    if ((count?.n || 0) >= settings.maxDownloadsPerIp) return {ok:false,reason:"ip"};
  }
  return {ok:false,reason:"traffic"};
}
