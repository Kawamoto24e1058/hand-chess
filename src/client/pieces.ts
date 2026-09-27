// 白も黒も同じ塗りつぶしの形にして、色だけで陣営を区別する (︎: 絵文字化を防ぐ)
const SOLID: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
export const glyphOf = (type: string) => SOLID[type] + "︎";
export const FILES = "abcdefgh";
export const sqName = (c: number, r: number) => FILES[c] + (8 - r);
