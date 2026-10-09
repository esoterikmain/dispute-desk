import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { REASON_LABELS, type DisputeRow, type StoreOrder } from "./types";

// The standard PDF fonts only cover WinAnsi, so anything outside Latin-1 is replaced.
const clean = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

const date = (iso?: string | null) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");

/** Build the evidence packet attached to a contested dispute. */
export async function evidencePdf(dispute: DisputeRow, order: StoreOrder | null, letter: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  const width = 612 - margin * 2;
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 792 - margin;

  const line = (text: string, font: PDFFont = regular, size = 10, color = rgb(0.1, 0.1, 0.12)) => {
    for (const paragraph of clean(text).split("\n")) {
      const words = paragraph.split(" ");
      let current = "";
      const flush = () => {
        if (y < margin + size) {
          page = pdf.addPage([612, 792]);
          y = 792 - margin;
        }
        page.drawText(current, { x: margin, y, size, font, color });
        y -= size * 1.45;
        current = "";
      };
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && current) flush();
        current = current ? `${current} ${word}` : word;
      }
      flush();
    }
  };
  const heading = (text: string) => {
    y -= 8;
    line(text, bold, 12);
    y -= 2;
  };

  line("Seller evidence packet", bold, 18);
  line(`PayPal case ${dispute.id}`, regular, 11, rgb(0.35, 0.35, 0.4));
  y -= 6;

  heading("Claim");
  line(`Reason: ${REASON_LABELS[dispute.reason] ?? dispute.reason}`);
  line(`Disputed amount: ${dispute.currency} ${dispute.amount.toFixed(2)}`);
  line(`Transaction: ${dispute.transaction_id ?? "-"}`);
  line(`Opened: ${date(dispute.created_at)}`);

  heading("Seller response");
  line(letter || "(no statement)");

  if (order) {
    heading("Order record");
    line(`Order ${order.id}, placed ${date(order.placed_at)}`);
    line(`Buyer: ${order.buyer_name} <${order.buyer_email}>`);
    line(`Ship to: ${order.shipping_address}`);
    for (const item of order.items) {
      line(`- ${item.qty} x ${item.name} @ ${order.currency} ${item.price.toFixed(2)}${item.description ? ` (${item.description})` : ""}`);
    }

    if (order.shipment) {
      heading("Shipment");
      line(`${order.shipment.carrier} tracking ${order.shipment.tracking_number}`);
      for (const event of order.shipment.events) {
        line(`${date(event.at)}  ${event.status}${event.location ? `, ${event.location}` : ""}`);
      }
    }
    if (order.refunds?.length) {
      heading("Refunds");
      for (const refund of order.refunds) line(`${refund.id}: ${order.currency} ${refund.amount.toFixed(2)} on ${date(refund.at)}`);
    }
    if (order.messages?.length) {
      heading("Customer correspondence");
      for (const m of order.messages) line(`[${date(m.at)}] ${m.from === "buyer" ? "Buyer" : "Seller"}: ${m.body}`);
    }
  }

  return pdf.save();
}
