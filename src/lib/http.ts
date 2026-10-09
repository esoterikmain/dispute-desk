import { connection } from "next/server";

/** Run a route handler at request time and turn thrown errors into JSON. */
export async function handle(fn: () => Promise<Response | object>): Promise<Response> {
  await connection();
  try {
    const result = await fn();
    return result instanceof Response ? result : Response.json(result);
  } catch (err) {
    console.error("[api]", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 400 });
  }
}

export type IdParams = { params: Promise<{ id: string }> };
