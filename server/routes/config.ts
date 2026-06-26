import { Hono } from "hono";
import { store } from "@main/store";

const app = new Hono();

/** GET / —— 全量配置 */
app.get("/", (c) => c.json(store.store));

/** GET /:keyPath —— 按 dot path 取值（如 library.scanDirs） */
app.get("/:keyPath", (c) => c.json(store.get(c.req.param("keyPath") as never)));

/** PUT /:keyPath —— 按 dot path 写值，body 为原始值 */
app.put("/:keyPath", async (c) => {
  const keyPath = c.req.param("keyPath");
  const value = await c.req.json().catch(() => undefined);
  store.set(keyPath as never, value);
  return c.json({ success: true });
});

/** POST /replace —— 用整盘配置替换当前 */
app.post("/replace", async (c) => {
  const payload = await c.req.json().catch(() => ({}));
  store.replaceAll(payload);
  return c.json({ success: true });
});

/** POST /reset —— 重置为默认配置 */
app.post("/reset", (c) => {
  store.clear();
  return c.json({ success: true });
});

export default app;
