import { z } from "zod";
import { handle } from "@/lib/http";
import { isLivePayPal } from "@/lib/paypal";
import { listOrders } from "@/lib/repo";
import { FULFILMENTS, PRODUCTS, createCheckout } from "@/lib/store";

const Body = z.object({ cart: z.array(z.object({ sku: z.string(), qty: z.number() })).max(10) });

export const GET = () =>
  handle(async () => ({
    products: PRODUCTS,
    fulfilments: FULFILMENTS,
    // The client ID is public by design: the PayPal JS SDK needs it in the browser.
    paypalClientId: isLivePayPal() ? process.env.PAYPAL_CLIENT_ID : null,
    orders: (await listOrders(30)).filter((o) => o.capture_id).slice(0, 8),
  }));

export const POST = (req: Request) => handle(async () => createCheckout(Body.parse(await req.json()).cart));
