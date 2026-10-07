/** One product the shop sells. */
export interface Product {
  /** Stock-keeping unit: a lowercase word, a hyphen and two digits, unique across the catalog. */
  sku: string;
  name: string;
  /** Price in cents. */
  priceCents: number;
  /** Units in the warehouse. */
  stock: number;
}

/** Everything the shop sells, one product per line. */
export const CATALOG: Product[] = [
  { sku: "pen-01", name: "Ballpoint pen", priceCents: 199, stock: 420 },
  { sku: "pen-02", name: "Fountain pen", priceCents: 2499, stock: 35 },
  { sku: "pencil-01", name: "Graphite pencil", priceCents: 99, stock: 800 },
  { sku: "note-01", name: "Pocket notebook", priceCents: 450, stock: 260 },
  { sku: "note-02", name: "Lined notebook A5", priceCents: 899, stock: 140 },
  { sku: "lamp-01", name: "Desk lamp", priceCents: 3499, stock: 22 },
  { sku: "clip-01", name: "Paper clips (100)", priceCents: 249, stock: 310 },
  { sku: "tape-01", name: "Masking tape", priceCents: 399, stock: 95 },
  { sku: "mug-01", name: "Coffee mug", priceCents: 1199, stock: 64 },
  { sku: "stapler-01", name: "Stapler", priceCents: 1599, stock: 48 },
  { sku: "folder-01", name: "Document folder", priceCents: 349, stock: 210 },
  { sku: "ruler-01", name: "Steel ruler 30 cm", priceCents: 699, stock: 75 },
  { sku: "eraser-01", name: "Eraser", priceCents: 129, stock: 500 },
  { sku: "marker-01", name: "Highlighter set", priceCents: 549, stock: 130 },
  { sku: "bin-01", name: "Wire waste bin", priceCents: 1899, stock: 18 },
  { sku: "chair-01", name: "Office chair", priceCents: 18999, stock: 6 },
  { sku: "mat-01", name: "Desk mat", priceCents: 2299, stock: 27 },
  { sku: "lamp-02", name: "Floor lamp", priceCents: 7999, stock: 9 },
  { sku: "tray-01", name: "Letter tray", priceCents: 1299, stock: 40 },
  { sku: "cable-01", name: "USB-C cable", priceCents: 1499, stock: 150 },
  { sku: "hub-01", name: "USB hub", priceCents: 2999, stock: 33 },
  { sku: "mouse-01", name: "Wireless mouse", priceCents: 2499, stock: 58 },
  { sku: "pad-01", name: "Mouse pad", priceCents: 799, stock: 120 },
  { sku: "stand-01", name: "Laptop stand", priceCents: 3999, stock: 21 },
  { sku: "mug-02", name: "Travel mug", priceCents: 1299, stock: 44 },
  { sku: "bottle-01", name: "Water bottle", priceCents: 1799, stock: 52 },
  { sku: "board-01", name: "Whiteboard 60x90", priceCents: 4599, stock: 12 },
  { sku: "marker-02", name: "Whiteboard markers", priceCents: 649, stock: 88 },
  { sku: "cork-01", name: "Cork board", priceCents: 2199, stock: 15 },
  { sku: "pin-01", name: "Push pins (50)", priceCents: 199, stock: 260 },
  { sku: "clock-01", name: "Wall clock", priceCents: 2799, stock: 19 },
  { sku: "plant-01", name: "Desk plant", priceCents: 1599, stock: 23 },
  { sku: "shelf-01", name: "Bookshelf", priceCents: 12999, stock: 4 },
  { sku: "hook-01", name: "Coat hook", priceCents: 499, stock: 70 },
  { sku: "label-01", name: "Label maker", priceCents: 3299, stock: 14 },
  { sku: "bag-01", name: "Laptop bag", priceCents: 5499, stock: 26 },
];
