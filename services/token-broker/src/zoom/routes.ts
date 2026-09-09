import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ZoomAuthError, type ZoomConnections } from "./connection.js";

export const bearer = (c: Context): string => c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
export function registerZoomRoutes(parent: Hono, zoom: ZoomConnections | null): void {
  const app = new Hono();
  app.onError((e, c) => {
    const error = e instanceof ZoomAuthError ? e : new ZoomAuthError("ZOOM_CONNECTION_UNAVAILABLE", 503);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (zoom && c.req.path === "/api/zoom/callback") return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zoom連携</title><main><h1>Zoomの連携を完了できませんでした</h1><p>連携を開始したタブから、もう一度お試しください。</p><a href="${zoom.config.webOrigin}">アプリへ戻る</a></main></html>`, error.status as 401);
    return c.json({ error: error.code }, error.status as 401);
  });
  app.use("/api/zoom/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.get("/api/zoom/config", c => c.json({ available: !!zoom }));
  app.get("/api/zoom/connect", async c => {
    if (!zoom) return c.json({ error: "ZOOM_NOT_CONFIGURED" }, 503);
    const flow = await zoom.start(c.req.query("challenge") ?? "");
    setCookie(c, `__Host-rcai_zoom_${flow.state}`, flow.cookie, { secure: true, httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 });
    return c.redirect(flow.url);
  });
  app.get("/api/zoom/callback", async c => {
    if (!zoom) return c.json({ error: "ZOOM_NOT_CONFIGURED" }, 503);
    const state = c.req.query("state") ?? "";
    if (!/^[\w-]{43}$/.test(state)) throw new ZoomAuthError("INVALID_ZOOM_STATE");
    const cookieName = `__Host-rcai_zoom_${state}`, cookie = getCookie(c, cookieName) ?? "";
    deleteCookie(c, cookieName, { secure: true, path: "/" });
    await zoom.callback(state, cookie, c.req.query("code") ?? "", !!c.req.query("error"));
    return c.redirect(`${zoom.config.webOrigin}/#zoom_oauth=${state}`);
  });
  app.post("/api/zoom/complete", async c => {
    if (!zoom) return c.json({ error: "ZOOM_NOT_CONFIGURED" }, 503);
    if (c.req.header("Origin") !== zoom.config.webOrigin) throw new ZoomAuthError("INVALID_ZOOM_ORIGIN", 403);
    const body = await c.req.json().catch(() => ({}));
    return c.json({ token: await zoom.complete(body.state, body.verifier) });
  });
  app.get("/api/zoom/status", async c => {
    if (!zoom) return c.json({ available: false, connected: false });
    return c.json({ available: true, ...await zoom.status(bearer(c)) });
  });
  app.post("/api/zoom/disconnect", async c => {
    if (!zoom) return c.json({ error: "ZOOM_NOT_CONFIGURED" }, 503);
    if (c.req.header("Origin") !== zoom.config.webOrigin) throw new ZoomAuthError("INVALID_ZOOM_ORIGIN", 403);
    await zoom.disconnect(bearer(c));
    return c.json({ connected: false });
  });
  parent.route("/", app);
}
