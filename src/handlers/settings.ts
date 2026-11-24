// Settings, the assistant list, and the public calendar image.
import { now } from "../clock";
import { LIMITS, type Env } from "../env";
import { err } from "../errors";
import { addMonths, localDay, validTimezone } from "../time";
import { NO_CONTENT, ok, type AssistantRow, type Cx, type Handler, type Step, type UserRow } from "../types";
import { iso, parseJson, randomToken } from "../util";
import { getUser, listAssistants, revokeAssistant } from "../services/accounts";
import { calendarMonth, type CalendarMonth } from "./reading";

function settingsView(user: UserRow, origin: string, manage: boolean) {
  return {
    rules: user.rules,
    preference: user.preference,
    expiry_options: parseJson<number[]>(user.expiry_options, LIMITS.expiry_options_default),
    notify: user.notify === 1,
    timezone: user.timezone,
    lang: user.lang,
    roles: { analysis: user.role_analysis, digest: user.role_digest, deep_read: user.role_deep_read, deep_dive: user.role_deep_dive },
    calendar_image: {
      enabled: user.calendar_enabled === 1,
      // The address is only shown to the manage tier.
      url: manage && user.calendar_enabled === 1 && user.calendar_secret ? `${origin}/c/${user.calendar_secret}.svg` : null,
    },
  };
}

export const getSettings: Handler = async (cx) => ok(settingsView(cx.user!, cx.origin, cx.device!.tier === "manage"));

function stepsOf(a: AssistantRow): Step[] {
  return parseJson<Step[]>(a.steps, []);
}

/** Who may be the default for a step: analysis, digest and deep read need a scheduled assistant with that step. */
function roleProblem(role: string, a: AssistantRow | undefined): boolean {
  if (!a || a.built_in === "dispatch" || !stepsOf(a).includes(role as Step)) return true;
  return role !== "deep_dive" && a.kind !== "scheduled";
}

export const updateSettings: Handler = async (cx) => {
  const user = cx.user!;
  const b = cx.body;
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (b.rules !== undefined) set("rules", b.rules);
  if (b.expiry_options !== undefined) set("expiry_options", JSON.stringify([...new Set<number>(b.expiry_options)].sort((x, y) => x - y)));
  if (b.notify !== undefined) set("notify", b.notify ? 1 : 0);
  if (b.lang !== undefined) set("lang", b.lang);
  if (b.timezone !== undefined) {
    if (!validTimezone(b.timezone)) throw err("bad_request", "不认识这个时区。", "Unknown time zone.");
    set("timezone", b.timezone);
  }
  if (b.roles !== undefined) {
    const assistants = await listAssistants(cx.env, user.id);
    for (const role of ["analysis", "digest", "deep_read", "deep_dive"] as const) {
      const id = b.roles[role];
      if (id === undefined) continue;
      if (id !== null && roleProblem(role, assistants.find((a) => a.id === id))) {
        throw err("bad_request", `这只助手不能做这一步：${role}。`, `This assistant cannot be the one for ${role}.`);
      }
      set(`role_${role}`, id);
    }
  }
  if (b.calendar_image_enabled !== undefined) {
    set("calendar_enabled", b.calendar_image_enabled ? 1 : 0);
    if (b.calendar_image_enabled && !user.calendar_secret) set("calendar_secret", randomToken(24));
  }
  if (sets.length > 0) {
    const statements = [cx.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...values, user.id)];
    // Turning notifications off also drops what was waiting to be sent.
    if (b.notify === false) statements.push(cx.env.DB.prepare("DELETE FROM notify_batches WHERE user_id = ?").bind(user.id));
    await cx.env.DB.batch(statements);
  }
  return ok(settingsView(await getUser(cx.env, user.id), cx.origin, true));
};

/** A new address; the old one stops working at once. */
export const rotateCalendarImage: Handler = async (cx) => {
  await cx.env.DB.prepare("UPDATE users SET calendar_secret = ? WHERE id = ?").bind(randomToken(24), cx.user!.id).run();
  return ok(settingsView(await getUser(cx.env, cx.user!.id), cx.origin, true));
};

// ---------------------------------------------------------------- assistants

export function assistantView(a: AssistantRow) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    steps: stepsOf(a),
    built_in: a.built_in !== null,
    connected_at: iso(a.connected_at),
    last_seen_at: iso(a.last_seen_at),
    runs_at: a.runs_at,
  };
}

export const listAssistantsHandler: Handler = async (cx) => {
  const assistants = (await listAssistants(cx.env, cx.user!.id)).filter((a) => a.built_in !== "dispatch");
  return ok({ assistants: assistants.map(assistantView), connect_url: `${cx.origin}/mcp` });
};

async function ownAssistant(cx: Cx): Promise<AssistantRow> {
  const a = await cx.env.DB.prepare("SELECT * FROM assistants WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND (built_in IS NULL OR built_in <> 'dispatch')")
    .bind(cx.path.id, cx.user!.id)
    .first<AssistantRow>();
  if (!a) throw err("not_found");
  return a;
}

export const updateAssistant: Handler = async (cx) => {
  const a = await ownAssistant(cx);
  const user = cx.user!;
  const statements: D1PreparedStatement[] = [];
  if (cx.body.steps !== undefined) {
    const steps = [...new Set<Step>(cx.body.steps)];
    if (a.built_in) throw err("conflict", "内置助手干哪几步不能改。", "The steps of the built-in assistant cannot be changed.");
    if (steps.length === 0) throw err("conflict", "至少留一步；不想用它就断开。", "Keep at least one step; disconnect the assistant if it should do nothing.");
    if (a.kind === "chat" && steps.some((s) => s !== "deep_dive")) throw err("conflict", "对话型助手只能深挖。", "A chat assistant can only deep dive.");
    if (steps.includes("triage")) throw err("conflict", "初筛由内置的分派助手做。", "Triage is done by the built-in dispatch assistant.");
    a.steps = JSON.stringify(steps);
    statements.push(cx.env.DB.prepare("UPDATE assistants SET steps = ? WHERE id = ? AND user_id = ?").bind(a.steps, a.id, user.id));
    // Steps it lost can no longer default to it.
    for (const role of ["analysis", "digest", "deep_read", "deep_dive"] as const) {
      if (!steps.includes(role)) {
        statements.push(cx.env.DB.prepare(`UPDATE users SET role_${role} = NULL WHERE id = ? AND role_${role} = ?`).bind(user.id, a.id));
      }
    }
  }
  if (cx.body.name !== undefined && cx.body.name.trim() !== a.name) {
    a.name = cx.body.name.trim();
    statements.push(cx.env.DB.prepare("UPDATE assistants SET name = ? WHERE id = ? AND user_id = ?").bind(a.name, a.id, user.id));
  }
  if (statements.length > 0) {
    try {
      await cx.env.DB.batch(statements);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw err("conflict", "已经有一只助手叫这个名字。", "Another assistant already has this name.");
      throw e;
    }
  }
  return ok(assistantView(a));
};

export const revokeAssistantHandler: Handler = async (cx) => {
  await revokeAssistant(cx.env, cx.user!, await ownAssistant(cx));
  return NO_CONTENT;
};

// ---------------------------------------------------------------- public calendar image (SVG only)

const THEMES = {
  light: { bg: "#ffffff", ink: "#111111", grey: "#b5b5b5", gold: "#b8892b", text: "#555555" },
  dark: { bg: "#111111", ink: "#f2f2f2", grey: "#5c5c5c", gold: "#d4a63a", text: "#a8a8a8" },
  clear: { bg: "none", ink: "#111111", grey: "#b5b5b5", gold: "#b8892b", text: "#555555" },
};

function monthSvg(cal: CalendarMonth, x0: number, y0: number, cell: number, c: (typeof THEMES)["light"]): string {
  let out = "";
  cal.days.forEach((d, i) => {
    const cx = x0 + (i % 7) * cell + cell / 2;
    const cy = y0 + Math.floor(i / 7) * cell + cell / 2;
    const r = cell * 0.26;
    if (d.mark === "future") return;
    if (d.mark === "empty") out += `<circle cx="${cx}" cy="${cy}" r="${(r * 0.25).toFixed(1)}" fill="${c.grey}"/>`;
    else if (d.mark === "saved") out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.grey}" stroke-width="1.5"/>`;
    else if (d.mark === "digest_unread") out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.ink}" stroke-width="1.5"/>`;
    else if (d.mark === "digest_read") out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.ink}"/>`;
    else out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.gold}"/>`;
    if (d.day === cal.today) {
      const h = cell * 0.42;
      out += `<rect x="${cx - h}" y="${cy - h}" width="${h * 2}" height="${h * 2}" fill="none" stroke="${c.ink}" stroke-width="0.75"/>`;
    }
  });
  return out;
}

/** GET /c/{secret}.svg — dots and numbers only: no titles, no text, no identity. Off unless the user turned it on. */
export async function calendarImage(env: Env, secret: string, params: URLSearchParams): Promise<Response> {
  const notFound = new Response(null, { status: 404 });
  if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) return notFound;
  const user = await env.DB.prepare("SELECT * FROM users WHERE calendar_secret = ? AND calendar_enabled = 1").bind(secret).first<UserRow>();
  if (!user) return notFound;
  const theme = THEMES[(params.get("theme") ?? "light") as keyof typeof THEMES] ?? THEMES.light;
  const year = params.get("range") === "year";
  const counts = params.get("counts") !== "0";
  const current = localDay(now(), user.timezone).slice(0, 7);
  const months = year ? Array.from({ length: 12 }, (_, i) => addMonths(current, i - 11)) : [current];
  const cals: CalendarMonth[] = [];
  for (const m of months) cals.push(await calendarMonth(env, user, m));
  const cell = year ? 12 : 32;
  const pad = year ? 10 : 16;
  const gap = year ? 10 : 0;
  const monthW = cell * 7;
  const gridH = cell * 6;
  const width = pad * 2 + monthW * cals.length + gap * (cals.length - 1);
  const height = pad * 2 + gridH + (counts ? 22 : 0);
  let body = theme.bg === "none" ? "" : `<rect width="${width}" height="${height}" fill="${theme.bg}"/>`;
  cals.forEach((cal, i) => {
    body += monthSvg(cal, pad + i * (monthW + gap), pad, cell, theme);
  });
  if (counts) {
    const total = cals.reduce((t, c) => ({ saved: t.saved + c.counts.saved, digests: t.digests + c.counts.digests, read: t.read + c.counts.read, notes: t.notes + c.counts.notes }), {
      saved: 0,
      digests: 0,
      read: 0,
      notes: 0,
    });
    // Numbers only, each next to the kind of dot it counts.
    const y = pad + gridH + 14;
    const parts: [string, number][] = [
      [`<circle cx="0" cy="-4" r="4" fill="none" stroke="${theme.grey}" stroke-width="1.5"/>`, total.saved],
      [`<circle cx="0" cy="-4" r="4" fill="none" stroke="${theme.ink}" stroke-width="1.5"/>`, total.digests],
      [`<circle cx="0" cy="-4" r="4" fill="${theme.ink}"/>`, total.read],
      [`<circle cx="0" cy="-4" r="4" fill="${theme.gold}"/>`, total.notes],
    ];
    parts.forEach(([dot, n], i) => {
      body += `<g transform="translate(${pad + 6 + i * 52},${y})">${dot}<text x="10" y="0" font-family="ui-monospace,Menlo,monospace" font-size="11" fill="${theme.text}">${n}</text></g>`;
    });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" },
  });
}
