"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, dateTime, money } from "@/components/format";
import type { StoreOrder } from "@/lib/types";

interface StoreData {
  products: Array<{ sku: string; name: string; price: number; description: string }>;
  fulfilments: Record<string, string>;
  paypalClientId: string | null;
  orders: StoreOrder[];
}

interface PayPalButtons {
  Buttons(config: {
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onError: (err: unknown) => void;
  }): { render: (el: HTMLElement) => Promise<void>; close: () => void };
}

const CLAIMS = [
  ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "Item not received"],
  ["MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "Not as described"],
  ["UNAUTHORISED", "Unauthorized"],
] as const;

export default function Store() {
  const [data, setData] = useState<StoreData | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({ "desk-organizer": 1 });
  const [fulfilment, setFulfilment] = useState("delivered_signed");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [paying, setPaying] = useState(false);
  const buttonsEl = useRef<HTMLDivElement>(null);
  // The PayPal buttons are rendered once; they read the latest cart through this ref.
  const latest = useRef({ cart, fulfilment });
  useEffect(() => {
    latest.current = { cart, fulfilment };
  }, [cart, fulfilment]);

  const load = useCallback(() => api<StoreData>("/api/store/orders").then(setData), []);
  useEffect(() => {
    load().catch((e) => setMessage({ tone: "bad", text: e.message }));
  }, [load]);

  const createOrder = useCallback(async () => {
    const lines = Object.entries(latest.current.cart).map(([sku, qty]) => ({ sku, qty }));
    const res = await api<{ paypalOrderId: string }>("/api/store/orders", { body: { cart: lines } });
    return res.paypalOrderId;
  }, []);

  const capture = useCallback(
    async (paypalOrderId: string) => {
      const order = await api<StoreOrder>("/api/store/capture", { body: { paypalOrderId, fulfilment: latest.current.fulfilment } });
      setMessage({ tone: "good", text: `Paid. Order ${order.id} recorded with capture ${order.capture_id}.` });
      await load();
    },
    [load],
  );

  const clientId = data?.paypalClientId;
  useEffect(() => {
    if (!clientId || !buttonsEl.current) return;
    const el = buttonsEl.current;
    let buttons: ReturnType<PayPalButtons["Buttons"]> | undefined;
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    script.onload = () => {
      const sdk = (window as unknown as { paypal?: PayPalButtons }).paypal;
      if (!sdk) return;
      buttons = sdk.Buttons({
        createOrder,
        onApprove: (d) => capture(d.orderID),
        onError: (err) => setMessage({ tone: "bad", text: String(err) }),
      });
      buttons.render(el);
    };
    script.onerror = () => setMessage({ tone: "bad", text: "Could not load the PayPal JavaScript SDK." });
    document.body.appendChild(script);
    return () => {
      buttons?.close();
      script.remove();
    };
  }, [clientId, createOrder, capture]);

  const total = (data?.products ?? []).reduce((sum, p) => sum + p.price * (cart[p.sku] ?? 0), 0);

  const simulatedPay = async () => {
    setPaying(true);
    try {
      await capture(await createOrder());
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPaying(false);
    }
  };

  const dispute = async (orderId: string, reason: string) => {
    try {
      const res = await api<{ id: string }>("/api/store/dispute", { body: { orderId, reason } });
      setMessage({ tone: "good", text: `Dispute ${res.id} opened. It is being analysed on the dashboard.` });
    } catch (e) {
      setMessage({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="min-h-screen">
      <header className="topbar">
        <div className="flex items-center gap-3">
          <div className="logo" aria-hidden>
            D
          </div>
          <div>
            <h1 className="font-semibold leading-tight">Demo store</h1>
            <p className="text-xs text-muted leading-tight">Make a payment so there is something to dispute</p>
          </div>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">
          Back to Dispute Desk
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <section className="card divide-y divide-line">
            {(data?.products ?? []).map((p) => (
              <div key={p.sku} className="flex items-center justify-between gap-4 px-5 py-4">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-muted">{p.description}</div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="tabular-nums font-medium">{money(p.price)}</span>
                  <input
                    className="input w-16"
                    type="number"
                    min={0}
                    max={10}
                    value={cart[p.sku] ?? 0}
                    onChange={(e) => setCart({ ...cart, [p.sku]: Number(e.target.value) })}
                    aria-label={`Quantity of ${p.name}`}
                  />
                </div>
              </div>
            ))}
          </section>

          <section className="card p-5">
            <h2 className="card-title">Recent paid orders</h2>
            {data && data.orders.length === 0 && <p className="text-sm text-muted">No orders yet.</p>}
            <ul className="divide-y divide-line">
              {(data?.orders ?? []).map((o) => (
                <li key={o.id} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span>
                      <span className="font-mono text-xs text-muted">{o.id}</span> &middot; {o.buyer_name} &middot;{" "}
                      {o.items.map((i) => `${i.qty} x ${i.name}`).join(", ")}
                    </span>
                    <span className="tabular-nums font-medium">{money(o.amount)}</span>
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {dateTime(o.placed_at)} &middot;{" "}
                    {o.shipment ? (o.shipment.delivered_at ? `Delivered${o.shipment.signed_by ? ", signed" : ""}` : "In transit") : "No tracking"}
                  </div>
                  {(o.capture_id.startsWith("CAP-") || o.capture_id.startsWith("SIMCAP-")) && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className="text-xs text-muted">Simulated order. Open a dispute as the buyer:</span>
                      {CLAIMS.map(([reason, label]) => (
                        <button key={reason} className="chip hover:border-accent hover:text-accent" onClick={() => dispute(o.id, reason)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="card-title">Checkout</h2>
              <span className="text-xl font-semibold tabular-nums">{money(total)}</span>
            </div>
            <label className="block text-xs text-muted mt-3 mb-1" htmlFor="fulfilment">
              Test fixture: how this order ships
            </label>
            <select id="fulfilment" className="input w-full" value={fulfilment} onChange={(e) => setFulfilment(e.target.value)}>
              {Object.entries(data?.fulfilments ?? {}).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1.5 mb-4">
              Sets the shipping record the agent will find, so you can test strong and weak evidence.
            </p>
            {data?.paypalClientId ? (
              <div ref={buttonsEl} />
            ) : (
              <button className="btn btn-primary w-full" disabled={paying || total === 0} onClick={simulatedPay}>
                {paying ? "Paying" : "Pay (simulated PayPal)"}
              </button>
            )}
            {message && <p className={`text-sm mt-3 ${message.tone === "good" ? "text-good" : "text-bad"}`}>{message.text}</p>}
          </section>

          <section className="card p-5 text-sm">
            <h2 className="card-title">{data?.paypalClientId ? "Disputing in the PayPal sandbox" : "Simulator mode"}</h2>
            {data?.paypalClientId ? (
              <ol className="list-decimal pl-4 space-y-1.5 text-muted">
                <li>Pay above with your sandbox personal (buyer) account.</li>
                <li>Log in to sandbox.paypal.com as that buyer and open the payment in Activity.</li>
                <li>Choose Report a problem and complete the form until you get a case ID.</li>
                <li>On the dashboard press Sync from PayPal, or Import case with that ID if it has not appeared yet.</li>
              </ol>
            ) : (
              <p className="text-muted">
                No PayPal credentials are configured, so payments and disputes are simulated locally. Set PAYPAL_CLIENT_ID and
                PAYPAL_CLIENT_SECRET to use the real sandbox.
              </p>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}
