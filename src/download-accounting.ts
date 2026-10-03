import type { Env } from "./types";
import type { ActivationCodeRow } from "./codes";
import { prepareQuotaDeduction } from "./codes";

/** D1 batch executes these statements sequentially in one transaction. */
export async function reserveDownload(
  env: Env, kind: "share" | "direct", token: string,
  code: ActivationCodeRow | null, bytes: number
): Promise<{ ok: boolean; reason?: "quota" | "link" }> {
  const table = kind === "share" ? "shares" : "direct_links";
  const now = Date.now();
  const available = `revoked = 0 AND (expires_at IS NULL OR expires_at >= ${now})
    AND (max_downloads IS NULL OR max_downloads = 0 OR download_count < max_downloads)`;
  if (!code) {
    const result = await env.db.prepare(`UPDATE ${table}
      SET download_count = download_count + 1 WHERE id = ?1 AND ${available}`)
      .bind(token).run();
    return result.meta.changes === 1 ? { ok: true } : { ok: false, reason: "link" };
  }
  // The quota update cannot run if the link is unavailable. The following
  // counter update runs only if that quota update changed a row (changes()).
  const results = await env.db.batch([
    prepareQuotaDeduction(env, code.id, bytes, now,
      `AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?4 AND ${available})`, [token]),
    env.db.prepare(`UPDATE ${table} SET download_count = download_count + 1
      WHERE id = ?1 AND changes() = 1 AND ${available}`).bind(token),
  ]);
  if (results[0].meta.changes !== 1) return { ok: false, reason: "quota" };
  return { ok: results[1].meta.changes === 1, reason: results[1].meta.changes === 1 ? undefined : "link" };
}
